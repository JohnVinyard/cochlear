/**
 * <timeseries-view>: draws a time series from an `.npz` on a <canvas>, on
 * the same time axis as <audio-view> and <annotation-timeline>, following
 * the "time series blobs" convention (docs/annotation-conventions.md): time
 * is the last axis. 2-d arrays, (rows, frames), are drawn as a heatmap with
 * row 0 at the bottom; 1-d arrays, (frames,), as a line.
 *
 * Attributes (strings, like <audio-view>):
 *   src            URL of the .npz
 *   array          which array in it (default: the first)
 *   frame-rate     frames per second (required)
 *   start-seconds  when frame 0 is, from the start of the sound (default 0)
 *   duration       the sound's duration: the width of the time axis
 *   rows           JSON: labels for the rows, first row first
 *   range          JSON: [min, max] for the colour scale (default: the data's)
 *   normalize      "global" (default) or "rows": scale each row on its own
 *   label          shown above the plot
 *   for            id of an <audio-view>: its `audio-view-played` events drive a playhead
 *
 * Events:
 *   timeseries-selected   detail: { seconds, row, value }, on click
 *
 * A vanilla custom element, in the style of <annotation-timeline>, so it can
 * be upstreamed to web-components with it.
 */
import { type NdArray, parseNpz } from './npz';

/** Approximately viridis: dark purple -> blue -> green -> yellow */
const STOPS: [number, number, number][] = [
    [68, 1, 84],
    [59, 82, 139],
    [33, 145, 140],
    [94, 201, 98],
    [253, 231, 37],
];

const colour = (x: number): [number, number, number] => {
    const t = Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0)) * (STOPS.length - 1);
    const i = Math.min(STOPS.length - 2, Math.floor(t));
    const f = t - i;
    const [a, b] = [STOPS[i]!, STOPS[i + 1]!];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
};

const cache = new Map<string, Promise<Map<string, NdArray>>>();

/** Blobs are immutable (content-addressed), so each URL is fetched once per page */
const load = (src: string): Promise<Map<string, NdArray>> => {
    let p = cache.get(src);
    if (!p) {
        p = fetch(src)
            .then((r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status} fetching the blob`);
                return r.arrayBuffer();
            })
            .then(parseNpz);
        p.catch(() => cache.delete(src));
        cache.set(src, p);
    }
    return p;
};

const HEIGHT_2D = 96;
const HEIGHT_1D = 48;

export class TimeseriesView extends HTMLElement {
    static get observedAttributes() {
        return ['src', 'array', 'frame-rate', 'start-seconds', 'duration', 'rows', 'range', 'normalize', 'label', 'for'];
    }

    private array: NdArray | null = null;
    private error: string | null = null;
    private loadedSrc: string | null = null;
    private resize = new ResizeObserver(() => this.draw());
    private source: HTMLElement | null = null;
    private playheadFrame: number | null = null;

    constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = `
            <style>
                :host { display: block; position: relative; font: 11px/1.3 system-ui, sans-serif; margin: 4px 0; }
                .label { display: flex; gap: 8px; color: var(--timeseries-view-label, inherit); opacity: .8; margin-bottom: 2px; }
                .hover { margin-left: auto; font-variant-numeric: tabular-nums; }
                .plot { position: relative; }
                canvas { display: block; width: 100%; cursor: crosshair;
                         background: var(--timeseries-view-background, rgba(127,127,127,0.08)); }
                .playhead { position: absolute; top: 0; bottom: 0; width: 1px; display: none; pointer-events: none;
                            background: var(--timeseries-view-playhead, #e5484d); }
                .status { position: absolute; inset: 0; display: flex; align-items: center; padding-left: 6px; opacity: .6; }
            </style>
            <div class="label"><span class="title"></span><span class="hover"></span></div>
            <div class="plot"><canvas></canvas><div class="playhead"></div><div class="status"></div></div>`;
        const canvas = root.querySelector('canvas')!;
        canvas.addEventListener('mousemove', (e) => this.hover(e));
        canvas.addEventListener('mouseleave', () => (this.$('.hover').textContent = ''));
        canvas.addEventListener('click', (e) => {
            const at = this.at(e);
            if (at) this.dispatchEvent(new CustomEvent('timeseries-selected', { bubbles: true, composed: true, detail: at }));
        });
    }

    connectedCallback() {
        this.resize.observe(this);
        this.bindSource();
        void this.reload();
    }

    disconnectedCallback() {
        this.resize.disconnect();
        this.unbindSource();
        if (this.playheadFrame !== null) cancelAnimationFrame(this.playheadFrame);
    }

    attributeChangedCallback(name: string) {
        if (!this.isConnected) return;
        if (name === 'for') this.bindSource();
        if (name === 'src' || name === 'array') void this.reload();
        else this.draw();
    }

    // -- attributes ---------------------------------------------------------

    private number(name: string, fallback: number): number {
        const n = Number(this.getAttribute(name));
        return this.hasAttribute(name) && Number.isFinite(n) ? n : fallback;
    }

    private json<T>(name: string): T | null {
        try {
            return JSON.parse(this.getAttribute(name) ?? 'null') as T;
        } catch {
            return null;
        }
    }

    private get frameRate() {
        return this.number('frame-rate', 0);
    }
    private get startSeconds() {
        return this.number('start-seconds', 0);
    }
    /** The time axis: the sound's duration, or the series' own */
    private get duration() {
        const own = this.array && this.frameRate > 0 ? this.startSeconds + this.frames / this.frameRate : 1;
        return this.number('duration', own) || own;
    }
    private get frames() {
        return this.array ? this.array.shape[this.array.shape.length - 1]! : 0;
    }
    private get rows() {
        return this.array && this.array.shape.length === 2 ? this.array.shape[0]! : 1;
    }

    private $<T extends HTMLElement = HTMLElement>(selector: string): T {
        return this.shadowRoot!.querySelector<T>(selector)!;
    }

    // -- loading ------------------------------------------------------------

    private async reload() {
        const src = this.getAttribute('src');
        this.$('.title').textContent = this.getAttribute('label') ?? '';
        if (!src) return;
        if (src === this.loadedSrc && this.array) return this.draw();
        this.loadedSrc = src;
        this.array = null;
        this.error = null;
        this.draw();
        try {
            const arrays = await load(src);
            if (src !== this.loadedSrc) return;
            const name = this.getAttribute('array');
            const array = name ? arrays.get(name) : arrays.values().next().value;
            if (!array) throw new Error(name ? `no array "${name}" in the .npz` : 'the .npz is empty');
            if (array.shape.length < 1 || array.shape.length > 2) {
                throw new Error(`can only draw 1-d or 2-d arrays, not shape (${array.shape.join(', ')})`);
            }
            this.array = array;
        } catch (e) {
            this.error = (e as Error).message;
        }
        this.draw();
    }

    // -- drawing ------------------------------------------------------------

    private draw() {
        const canvas = this.$<HTMLCanvasElement>('canvas');
        const status = this.$('.status');
        this.$('.title').textContent = this.getAttribute('label') ?? '';
        const twoD = !this.array || this.array.shape.length === 2;
        const height = twoD ? HEIGHT_2D : HEIGHT_1D;
        canvas.style.height = `${height}px`;
        status.textContent = this.error ?? (this.array ? '' : 'Loading…');
        status.hidden = !status.textContent;
        if (!this.array || this.frameRate <= 0) {
            if (this.array) status.textContent = 'frame-rate is required';
            status.hidden = !status.textContent;
            return;
        }
        const dpr = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round((canvas.clientWidth || this.clientWidth || 600) * dpr));
        canvas.width = width;
        canvas.height = Math.round(height * dpr);
        const g = canvas.getContext('2d')!;
        g.clearRect(0, 0, canvas.width, canvas.height);
        const columns = this.columns(width);
        if (twoD) this.drawHeatmap(g, columns, width, canvas.height);
        else this.drawLine(g, columns, width, canvas.height);
    }

    /**
     * Each pixel column's mean value per row (NaN where there's no data):
     * `out[row][x]`. Columns map to time on the shared axis, so the plot lines
     * up with the waveform and the annotation timeline.
     */
    private columns(width: number): Float32Array[] {
        const { data } = this.array!;
        const frames = this.frames;
        const secondsPerPixel = this.duration / width;
        return Array.from({ length: this.rows }, (_, r) => {
            const out = new Float32Array(width).fill(NaN);
            for (let x = 0; x < width; x++) {
                const t0 = x * secondsPerPixel - this.startSeconds;
                const from = Math.max(0, Math.floor(t0 * this.frameRate));
                const to = Math.min(frames, Math.max(from + 1, Math.floor((t0 + secondsPerPixel) * this.frameRate)));
                if (from >= frames || to <= 0) continue;
                let sum = 0;
                for (let f = from; f < to; f++) sum += data[r * frames + f]!;
                out[x] = sum / (to - from);
            }
            return out;
        });
    }

    private scale(values: Float32Array[]): (row: number, v: number) => number {
        const fixed = this.json<[number, number]>('range');
        const extent = (rows: Float32Array[]): [number, number] => {
            let lo = Infinity;
            let hi = -Infinity;
            for (const row of rows) for (const v of row) if (Number.isFinite(v)) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
            return lo <= hi ? [lo, hi] : [0, 1];
        };
        const ranges =
            Array.isArray(fixed) && fixed.length === 2
                ? values.map(() => fixed)
                : this.getAttribute('normalize') === 'rows'
                  ? values.map((row) => extent([row]))
                  : values.map(() => extent(values));
        return (row, v) => {
            const [lo, hi] = ranges[row]!;
            return hi > lo ? (v - lo) / (hi - lo) : 0.5;
        };
    }

    private drawHeatmap(g: CanvasRenderingContext2D, columns: Float32Array[], width: number, height: number) {
        const rows = columns.length;
        const scale = this.scale(columns);
        const image = g.createImageData(width, rows);
        for (let r = 0; r < rows; r++) {
            const y = rows - 1 - r; // row 0 at the bottom
            for (let x = 0; x < width; x++) {
                const v = columns[r]![x]!;
                const i = (y * width + x) * 4;
                if (!Number.isFinite(v)) continue; // transparent
                const [red, green, blue] = colour(scale(r, v));
                image.data[i] = red;
                image.data[i + 1] = green;
                image.data[i + 2] = blue;
                image.data[i + 3] = 255;
            }
        }
        // one pixel per row, stretched to the plot's height without smoothing
        const scratch = new OffscreenCanvas(width, rows);
        scratch.getContext('2d')!.putImageData(image, 0, 0);
        g.imageSmoothingEnabled = false;
        g.drawImage(scratch, 0, 0, width, height);
    }

    private drawLine(g: CanvasRenderingContext2D, columns: Float32Array[], width: number, height: number) {
        const scale = this.scale(columns);
        const row = columns[0]!;
        g.strokeStyle = getComputedStyle(this).getPropertyValue('--timeseries-view-line').trim() || '#5b8def';
        g.lineWidth = window.devicePixelRatio || 1;
        g.beginPath();
        let drawing = false;
        for (let x = 0; x < width; x++) {
            const v = row[x]!;
            if (!Number.isFinite(v)) {
                drawing = false;
                continue;
            }
            const y = height - 2 - scale(0, v) * (height - 4);
            if (drawing) g.lineTo(x, y);
            else g.moveTo(x, y);
            drawing = true;
        }
        g.stroke();
    }

    // -- interaction --------------------------------------------------------

    /** The time, row and value under the mouse */
    private at(e: MouseEvent): { seconds: number; row: number; value: number | null } | null {
        if (!this.array || this.frameRate <= 0) return null;
        const rect = this.$('canvas').getBoundingClientRect();
        const seconds = ((e.clientX - rect.left) / rect.width) * this.duration;
        const row = this.rows - 1 - Math.min(this.rows - 1, Math.floor(((e.clientY - rect.top) / rect.height) * this.rows));
        const frame = Math.floor((seconds - this.startSeconds) * this.frameRate);
        const value = frame >= 0 && frame < this.frames ? this.array.data[row * this.frames + frame]! : null;
        return { seconds, row, value };
    }

    private hover(e: MouseEvent) {
        const at = this.at(e);
        if (!at) return;
        const labels = this.json<string[]>('rows');
        const row = this.rows > 1 ? ` · ${labels?.[at.row] ?? `row ${at.row}`}` : '';
        const value = at.value === null ? '' : ` · ${Number(at.value.toPrecision(3))}`;
        this.$('.hover').textContent = `${at.seconds.toFixed(2)}s${row}${value}`;
    }

    private readonly onPlayed = (e: Event) => {
        const { startSeconds, durationSeconds } = (e as CustomEvent).detail;
        if (this.playheadFrame !== null) cancelAnimationFrame(this.playheadFrame);
        const began = performance.now();
        const head = this.$('.playhead');
        const tick = () => {
            const elapsed = (performance.now() - began) / 1000;
            if (elapsed > durationSeconds) {
                head.style.display = 'none';
                this.playheadFrame = null;
                return;
            }
            head.style.display = 'block';
            head.style.left = `${((startSeconds + elapsed) / this.duration) * 100}%`;
            this.playheadFrame = requestAnimationFrame(tick);
        };
        this.playheadFrame = requestAnimationFrame(tick);
    };

    private bindSource() {
        this.unbindSource();
        const id = this.getAttribute('for');
        this.source = id ? document.getElementById(id) : null;
        this.source?.addEventListener('audio-view-played', this.onPlayed);
    }

    private unbindSource() {
        this.source?.removeEventListener('audio-view-played', this.onPlayed);
        this.source = null;
    }
}

if (!customElements.get('timeseries-view')) customElements.define('timeseries-view', TimeseriesView);
