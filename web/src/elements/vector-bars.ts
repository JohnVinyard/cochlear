/**
 * <vector-bars>: a vector as a small bar chart, one bar per dimension,
 * growing up or down from a zero baseline. Hover a bar for its index and
 * value. Vectors with more dimensions than the chart has room for (an
 * embedding, say) are drawn as a min/max band per pixel column instead.
 *
 * Attributes:
 *   width, height   in CSS pixels (default 140 × 28)
 *   labels          JSON: a name per dimension, for the tooltip (e.g. pitch classes)
 *
 * Properties:
 *   values          the vector (number[])
 *
 * Styling: --vector-bars-color, --vector-bars-baseline.
 *
 * A vanilla custom element, like <annotation-timeline>, so it can be
 * upstreamed to web-components.
 */

/** Between bars, and the smallest a bar may be before switching to bands */
const GAP = 2;
const MIN_BAR = 2;

export class VectorBars extends HTMLElement {
    static get observedAttributes() {
        return ['width', 'height', 'labels'];
    }

    private _values: number[] = [];
    private hovered: number | null = null;

    constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = `
            <style>
                :host {
                    display: inline-block; position: relative; vertical-align: middle;
                    --color: var(--vector-bars-color, #2a78d6);
                    --baseline: var(--vector-bars-baseline, #c3c2b7);
                }
                @media (prefers-color-scheme: dark) {
                    :host { --color: var(--vector-bars-color, #3987e5); --baseline: var(--vector-bars-baseline, #383835); }
                }
                canvas { display: block; cursor: crosshair; }
                .tip { position: absolute; bottom: calc(100% + 4px); transform: translateX(-50%); display: none;
                       pointer-events: none; white-space: nowrap; padding: 2px 6px; border-radius: 4px;
                       font: 11px/1.3 system-ui, sans-serif; font-variant-numeric: tabular-nums;
                       background: #2c2c2a; color: #f0efec; z-index: 1;
                       box-shadow: 0 0 0 1px rgba(255,255,255,0.10), 0 2px 8px rgba(0,0,0,0.3); }
            </style>
            <canvas role="img"></canvas>
            <div class="tip"></div>`;
        const canvas = root.querySelector('canvas')!;
        canvas.addEventListener('mousemove', (e) => {
            const rect = canvas.getBoundingClientRect();
            const i = Math.floor(((e.clientX - rect.left) / rect.width) * this._values.length);
            this.hover(Math.min(this._values.length - 1, Math.max(0, i)), e.clientX - rect.left);
        });
        canvas.addEventListener('mouseleave', () => this.hover(null, 0));
    }

    get values(): number[] {
        return this._values;
    }
    set values(v: number[]) {
        this._values = Array.isArray(v) ? v.map(Number) : [];
        this.draw();
    }

    connectedCallback() {
        this.draw();
    }

    attributeChangedCallback() {
        this.draw();
    }

    private size(name: string, fallback: number): number {
        const n = Number(this.getAttribute(name));
        return Number.isFinite(n) && n > 0 ? n : fallback;
    }

    private get labels(): string[] | null {
        try {
            const l = JSON.parse(this.getAttribute('labels') ?? 'null');
            return Array.isArray(l) ? l.map(String) : null;
        } catch {
            return null;
        }
    }

    private hover(index: number | null, x: number) {
        this.hovered = index;
        const tip = this.shadowRoot!.querySelector<HTMLElement>('.tip')!;
        if (index === null || !this._values.length) {
            tip.style.display = 'none';
        } else {
            const v = this._values[index]!;
            const name = this.labels?.[index] ?? `#${index}`;
            tip.textContent = `${name}: ${Number(v.toPrecision(4))}`;
            tip.style.left = `${x}px`;
            tip.style.display = 'block';
        }
        this.draw();
    }

    private draw() {
        const canvas = this.shadowRoot!.querySelector('canvas')!;
        const width = this.size('width', 140);
        const height = this.size('height', 28);
        const dpr = window.devicePixelRatio || 1;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        const values = this._values;
        const n = values.length;
        const lo = Math.min(0, ...values.filter(Number.isFinite));
        const hi = Math.max(0, ...values.filter(Number.isFinite));
        canvas.setAttribute(
            'aria-label',
            n ? `${n}-dimensional vector, from ${Number(lo.toPrecision(3))} to ${Number(hi.toPrecision(3))}` : 'empty vector'
        );
        const g = canvas.getContext('2d')!;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, width, height);
        if (!n) return;
        const style = getComputedStyle(this);
        const color = style.getPropertyValue('--color').trim() || '#2a78d6';
        const baseline = style.getPropertyValue('--baseline').trim() || '#c3c2b7';
        const span = hi - lo || 1;
        const y = (v: number) => ((hi - v) / span) * (height - 1);
        const zero = y(0);

        const barWidth = (width - GAP * (n - 1)) / n;
        if (barWidth >= MIN_BAR) {
            for (let i = 0; i < n; i++) {
                const v = values[i]!;
                if (!Number.isFinite(v) || v === 0) continue;
                const x = i * (barWidth + GAP);
                const top = Math.min(y(v), zero);
                const h = Math.max(1, Math.abs(y(v) - zero));
                g.globalAlpha = this.hovered === null || this.hovered === i ? 1 : 0.45;
                g.fillStyle = color;
                // the data end is rounded; the end on the baseline stays square
                const r = Math.min(2, barWidth / 2, h);
                g.beginPath();
                g.roundRect(x, top, barWidth, h, v > 0 ? [r, r, 0, 0] : [0, 0, r, r]);
                g.fill();
            }
        } else {
            // too many dimensions for a bar each: each pixel column shows the range of the values it covers
            g.fillStyle = color;
            for (let px = 0; px < width; px++) {
                const from = Math.floor((px / width) * n);
                const to = Math.max(from + 1, Math.floor(((px + 1) / width) * n));
                let min = 0;
                let max = 0;
                for (let i = from; i < to; i++) {
                    const v = values[i]!;
                    if (Number.isFinite(v)) (min = Math.min(min, v)), (max = Math.max(max, v));
                }
                g.globalAlpha = this.hovered === null || (this.hovered >= from && this.hovered < to) ? 1 : 0.45;
                g.fillRect(px, y(max), 1, Math.max(1, y(min) - y(max)));
            }
        }
        g.globalAlpha = 1;
        g.fillStyle = baseline;
        g.fillRect(0, Math.round(zero) - 0.5, width, 1);
    }
}

if (!customElements.get('vector-bars')) customElements.define('vector-bars', VectorBars);
