/**
 * <scatter-3d>: an interactive 3-d scatterplot (three.js), e.g. of a t-SNE
 * projection. Drag to orbit, scroll to zoom, hover for a label, click a point
 * to select it.
 *
 * Dark, with toon-shaded points (three bands of light from a lamp that moves
 * with the camera) and fog for depth (far points fade into the background),
 * hairline axes through the origin and a faint floor grid. The axes have no units:
 * for a t-SNE layout only relative positions mean anything.
 *
 * Properties:
 *   points      [{ color: [r, g, b], label, size?, group? }]: sets what's drawn (and resets positions).
 *               Hovering a point highlights every point in its group, and dims the rest.
 *   positions   Float32Array, 3 per point: may be updated repeatedly, e.g. as a layout settles;
 *               they're centred and scaled to fit
 *   selected    index of a point to emphasise, or null
 *
 * Events:
 *   point-selected   detail: { index }
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface ScatterPoint {
    color: [number, number, number];
    label: string;
    /** Relative size; default 1 */
    size?: number;
    /** Points in the same group (e.g. from the same sound) are highlighted together on hover */
    group?: string | number;
}

/** Chart chrome, dark (see the dataviz palette's "chart chrome & ink") */
const SURFACE = 0x1a1a19;
const AXIS = 0x4a4945;
const GRID = 0x2c2c2a;
const EXTENT = 1.15;
/** How far towards the background dimmed points go */
const DIM = 0.78;

/**
 * Toon shading: light falls into three flat bands. With these intensities
 * (three.js divides diffuse light by π) the lit band is about the point's own
 * palette colour, and the shadow side about 60% of it.
 */
const AMBIENT = 0.35 * Math.PI;
const LAMP = 0.7 * Math.PI;
const BANDS = [0.4, 0.7, 1.0];

const toonGradient = (): THREE.DataTexture => {
    const texture = new THREE.DataTexture(Uint8Array.from(BANDS, (b) => Math.round(b * 255)), BANDS.length, 1, THREE.RedFormat);
    texture.minFilter = texture.magFilter = THREE.NearestFilter; // hard steps between bands
    texture.needsUpdate = true;
    return texture;
};

const RADIUS = 0.025;
const HEIGHT = 420;

export class Scatter3d extends HTMLElement {
    private renderer: THREE.WebGLRenderer | null = null;
    private readonly scene = new THREE.Scene();
    private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    private controls: OrbitControls | null = null;
    private mesh: THREE.InstancedMesh | null = null;
    private readonly geometry = new THREE.SphereGeometry(RADIUS, 24, 16);
    private readonly gradient = toonGradient();
    private readonly material = new THREE.MeshToonMaterial({ gradientMap: this.gradient });
    private readonly raycaster = new THREE.Raycaster();
    private readonly pointer = new THREE.Vector2();
    private _points: ScatterPoint[] = [];
    private fitted = new Float32Array(0);
    private _selected: number | null = null;
    private hovered: number | null = null;
    private down: { x: number; y: number } | null = null;
    private resize = new ResizeObserver(() => this.layout());

    constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = `
            <style>
                :host { display: block; position: relative; height: ${HEIGHT}px; touch-action: none; }
                canvas { display: block; width: 100%; height: 100%; border-radius: 6px; background: #1a1a19;
                         box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10); }
                .tip { position: absolute; pointer-events: none; padding: 4px 8px; border-radius: 4px; display: none;
                       font: 12px/1.3 system-ui, sans-serif; white-space: nowrap; color: #f0efec;
                       background: #2c2c2a; box-shadow: 0 0 0 1px rgba(255,255,255,0.10), 0 4px 12px rgba(0,0,0,0.4); }
            </style>
            <div class="tip"></div>`;
        this.camera.position.set(1.6, 1.1, 2.6);
        this.scene.background = new THREE.Color(SURFACE);
        // the layout fits a unit sphere; the camera is ~3.2 from its centre
        this.scene.fog = new THREE.Fog(SURFACE, 2.4, 5.2);
        this.scene.add(this.axes());
        this.scene.add(new THREE.AmbientLight(0xffffff, AMBIENT));
        // a lamp riding on the camera, above and to the left: shading stays put as you orbit
        const lamp = new THREE.DirectionalLight(0xffffff, LAMP);
        lamp.position.set(-1.5, 2, 1);
        lamp.target.position.set(0, 0, -3);
        this.camera.add(lamp, lamp.target);
        this.scene.add(this.camera);
    }

    /** Hairline x, y and z axes through the origin, and a faint grid on the floor */
    private axes(): THREE.Group {
        const group = new THREE.Group();
        const e = EXTENT;
        const lines = new THREE.BufferGeometry().setAttribute(
            'position',
            new THREE.Float32BufferAttribute([-e, 0, 0, e, 0, 0, 0, -e, 0, 0, e, 0, 0, 0, -e, 0, 0, e], 3)
        );
        group.add(new THREE.LineSegments(lines, new THREE.LineBasicMaterial({ color: AXIS })));
        const grid = new THREE.GridHelper(2 * e, 8, GRID, GRID);
        grid.position.y = -e;
        group.add(grid);
        return group;
    }

    connectedCallback() {
        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(window.devicePixelRatio || 1);
        this.shadowRoot!.prepend(renderer.domElement);
        this.renderer = renderer;
        this.controls = new OrbitControls(this.camera, renderer.domElement);
        this.controls.enableDamping = true;
        const canvas = renderer.domElement;
        canvas.addEventListener('pointermove', this.onMove);
        canvas.addEventListener('pointerdown', this.onDown);
        canvas.addEventListener('pointerup', this.onUp);
        canvas.addEventListener('pointerleave', this.onLeave);
        this.resize.observe(this);
        this.layout();
        this.rebuild();
        renderer.setAnimationLoop(() => {
            this.controls!.update();
            renderer.render(this.scene, this.camera);
        });
    }

    disconnectedCallback() {
        this.resize.disconnect();
        this.renderer?.setAnimationLoop(null);
        this.controls?.dispose();
        this.renderer?.domElement.remove();
        this.renderer?.dispose();
        this.renderer = null;
        this.mesh?.dispose();
    }

    /** For good: frees the GPU resources shared by every redraw (disconnecting alone keeps them) */
    dispose() {
        this.geometry.dispose();
        this.material.dispose();
        this.gradient.dispose();
    }

    get points() {
        return this._points;
    }
    set points(points: ScatterPoint[]) {
        this._points = points;
        this.fitted = new Float32Array(points.length * 3);
        this._selected = null;
        this.hovered = null;
        this.rebuild();
    }

    set positions(positions: Float32Array) {
        const n = this._points.length;
        if (positions.length !== n * 3) return;
        // centre on the mean, and scale so the farthest point is at radius 1
        const mean = [0, 0, 0];
        for (let i = 0; i < n * 3; i++) mean[i % 3]! += positions[i]! / n;
        let radius = 1e-9;
        for (let i = 0; i < n; i++) {
            radius = Math.max(radius, Math.hypot(...[0, 1, 2].map((k) => positions[i * 3 + k]! - mean[k]!)));
        }
        for (let i = 0; i < n * 3; i++) this.fitted[i] = (positions[i]! - mean[i % 3]!) / radius;
        this.updateMatrices();
    }

    get selected() {
        return this._selected;
    }
    set selected(index: number | null) {
        this._selected = index;
        this.updateMatrices();
    }

    private layout() {
        if (!this.renderer) return;
        const width = this.clientWidth || 600;
        const height = this.clientHeight || HEIGHT;
        this.renderer.setSize(width, height, false);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
    }

    private rebuild() {
        if (this.mesh) {
            this.scene.remove(this.mesh);
            this.mesh.dispose();
            this.mesh = null;
        }
        if (!this._points.length) return;
        this.mesh = new THREE.InstancedMesh(this.geometry, this.material, this._points.length);
        this.scene.add(this.mesh);
        this.updateColours();
        this.updateMatrices();
    }

    private readonly colour = new THREE.Color();
    private readonly surface = new THREE.Color(SURFACE);

    /** Each point's colour; while hovering, points outside the hovered group are dimmed */
    private updateColours() {
        const mesh = this.mesh;
        if (!mesh) return;
        const group = this.hovered === null ? undefined : this._points[this.hovered]?.group;
        this._points.forEach((p, i) => {
            this.colour.setRGB(p.color[0] / 255, p.color[1] / 255, p.color[2] / 255, THREE.SRGBColorSpace);
            if (group !== undefined && p.group !== group) this.colour.lerp(this.surface, DIM);
            mesh.setColorAt(i, this.colour);
        });
        mesh.instanceColor!.needsUpdate = true;
    }

    private readonly matrix = new THREE.Matrix4();
    private readonly scale = new THREE.Vector3();
    private readonly position = new THREE.Vector3();
    private readonly rotation = new THREE.Quaternion();

    private updateMatrices() {
        const mesh = this.mesh;
        if (!mesh) return;
        this._points.forEach((p, i) => {
            const emphasis = i === this._selected ? 2.2 : i === this.hovered ? 1.6 : 1;
            this.position.set(this.fitted[i * 3]!, this.fitted[i * 3 + 1]!, this.fitted[i * 3 + 2]!);
            this.scale.setScalar((p.size ?? 1) * emphasis);
            mesh.setMatrixAt(i, this.matrix.compose(this.position, this.rotation, this.scale));
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere(); // raycasting relies on it
    }

    private pick(e: PointerEvent): number | null {
        if (!this.mesh || !this.renderer) return null;
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        this.raycaster.setFromCamera(this.pointer, this.camera);
        return this.raycaster.intersectObject(this.mesh)[0]?.instanceId ?? null;
    }

    private readonly onMove = (e: PointerEvent) => {
        const index = this.pick(e);
        if (index !== this.hovered) {
            const before = this.hovered === null ? undefined : this._points[this.hovered]?.group;
            this.hovered = index;
            const after = index === null ? undefined : this._points[index]?.group;
            if (before !== after) this.updateColours();
            this.updateMatrices();
        }
        const tip = this.shadowRoot!.querySelector<HTMLElement>('.tip')!;
        this.renderer!.domElement.style.cursor = index === null ? 'grab' : 'pointer';
        if (index === null) {
            tip.style.display = 'none';
            return;
        }
        const rect = this.getBoundingClientRect();
        tip.textContent = this._points[index]!.label;
        tip.style.display = 'block';
        tip.style.left = `${Math.min(e.clientX - rect.left + 12, rect.width - tip.offsetWidth - 4)}px`;
        tip.style.top = `${e.clientY - rect.top + 12}px`;
    };

    private readonly onDown = (e: PointerEvent) => {
        this.down = { x: e.clientX, y: e.clientY };
    };

    /** A click, not the end of an orbit drag */
    private readonly onUp = (e: PointerEvent) => {
        const down = this.down;
        this.down = null;
        if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
        const index = this.pick(e);
        if (index === null) return;
        this.selected = index;
        this.dispatchEvent(new CustomEvent('point-selected', { bubbles: true, composed: true, detail: { index } }));
    };

    private readonly onLeave = () => {
        this.hovered = null;
        this.updateColours();
        this.shadowRoot!.querySelector<HTMLElement>('.tip')!.style.display = 'none';
        this.updateMatrices();
    };
}

if (!customElements.get('scatter-3d')) customElements.define('scatter-3d', Scatter3d);
