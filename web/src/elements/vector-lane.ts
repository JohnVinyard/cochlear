/**
 * <vector-lane>: one lane of segments (e.g. a sound's vector annotations) on
 * the same time axis as <audio-view>, drawn on a canvas so thousands of
 * segments stay cheap. Each segment has its own colour.
 *
 * Attributes:
 *   duration   the sound's duration, in seconds: the width of the lane
 *   label      shown above it
 *   for        id of an <audio-view>: its `audio-view-played` events drive a playhead
 *
 * Properties:
 *   segments   [{ id, start_seconds, duration_seconds, color: [r, g, b] }]
 *   selected   the id of a segment to outline, or null
 *
 * Events:
 *   segment-selected   detail: { id, startSeconds, durationSeconds }
 */

export interface LaneSegment {
    id: number;
    start_seconds: number;
    duration_seconds: number;
    color: [number, number, number];
}

const HEIGHT = 22;

export class VectorLane extends HTMLElement {
    static get observedAttributes() {
        return ['duration', 'label', 'for'];
    }

    private _segments: LaneSegment[] = [];
    private _selected: number | null = null;
    private hovered: LaneSegment | null = null;
    private resize = new ResizeObserver(() => this.draw());
    private source: HTMLElement | null = null;
    private playheadFrame: number | null = null;

    constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = `
            <style>
                :host { display: block; font: 11px/1.3 system-ui, sans-serif; margin: 4px 0; }
                .label { display: flex; gap: 8px; opacity: .8; margin-bottom: 2px; }
                .hover { margin-left: auto; font-variant-numeric: tabular-nums; }
                .plot { position: relative; }
                canvas { display: block; width: 100%; height: ${HEIGHT}px; cursor: pointer;
                         background: var(--vector-lane-background, rgba(127,127,127,0.08)); }
                .playhead { position: absolute; top: 0; bottom: 0; width: 1px; display: none; pointer-events: none;
                            background: var(--vector-lane-playhead, #e5484d); }
            </style>
            <div class="label"><span class="title"></span><span class="hover"></span></div>
            <div class="plot"><canvas></canvas><div class="playhead"></div></div>`;
        const canvas = root.querySelector('canvas')!;
        canvas.addEventListener('mousemove', (e) => {
            this.hovered = this.at(e);
            const h = this.hovered;
            this.$('.hover').textContent = h
                ? `${h.start_seconds.toFixed(2)}s – ${(h.start_seconds + h.duration_seconds).toFixed(2)}s · click to find similar`
                : '';
            this.draw();
        });
        canvas.addEventListener('mouseleave', () => {
            this.hovered = null;
            this.$('.hover').textContent = '';
            this.draw();
        });
        canvas.addEventListener('click', (e) => {
            const s = this.at(e);
            if (!s) return;
            this.dispatchEvent(
                new CustomEvent('segment-selected', {
                    bubbles: true,
                    composed: true,
                    detail: { id: s.id, startSeconds: s.start_seconds, durationSeconds: s.duration_seconds, timeStamp: e.timeStamp },
                })
            );
        });
    }

    get segments() {
        return this._segments;
    }
    set segments(value: LaneSegment[]) {
        this._segments = [...value].sort((a, b) => a.start_seconds - b.start_seconds);
        this.draw();
    }

    get selected() {
        return this._selected;
    }
    set selected(id: number | null) {
        this._selected = id;
        this.draw();
    }

    connectedCallback() {
        this.resize.observe(this);
        this.bindSource();
        this.draw();
    }

    disconnectedCallback() {
        this.resize.disconnect();
        this.source?.removeEventListener('audio-view-played', this.onPlayed);
        if (this.playheadFrame !== null) cancelAnimationFrame(this.playheadFrame);
    }

    attributeChangedCallback(name: string) {
        if (name === 'for') this.bindSource();
        this.draw();
    }

    private $(selector: string): HTMLElement {
        return this.shadowRoot!.querySelector<HTMLElement>(selector)!;
    }

    private get duration() {
        const d = Number(this.getAttribute('duration'));
        return Number.isFinite(d) && d > 0 ? d : 1;
    }

    /** The segment under the mouse: binary search, segments being sorted by start */
    private at(e: MouseEvent): LaneSegment | null {
        const rect = this.$('canvas').getBoundingClientRect();
        const t = ((e.clientX - rect.left) / rect.width) * this.duration;
        const slop = (3 / rect.width) * this.duration; // a few pixels, for tiny segments
        let lo = 0;
        let hi = this._segments.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this._segments[mid]!.start_seconds <= t) lo = mid;
            else hi = mid - 1;
        }
        for (const s of [this._segments[lo], this._segments[lo + 1], this._segments[lo - 1]]) {
            if (s && t >= s.start_seconds - slop && t <= s.start_seconds + s.duration_seconds + slop) return s;
        }
        return null;
    }

    private draw() {
        this.$('.title').textContent = this.getAttribute('label') ?? '';
        const canvas = this.$('canvas') as HTMLCanvasElement;
        const dpr = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round((canvas.clientWidth || 600) * dpr));
        const height = Math.round(HEIGHT * dpr);
        canvas.width = width;
        canvas.height = height;
        const g = canvas.getContext('2d')!;
        const x = (t: number) => (t / this.duration) * width;
        for (const s of this._segments) {
            g.fillStyle = `rgb(${s.color.join(',')})`;
            g.fillRect(x(s.start_seconds), 0, Math.max(1, x(s.duration_seconds)), height);
        }
        for (const [s, colour] of [
            [this.hovered, 'rgba(255,255,255,0.9)'],
            [this._segments.find((s) => s.id === this._selected), '#e5484d'],
        ] as const) {
            if (!s) continue;
            g.strokeStyle = colour;
            g.lineWidth = 2 * dpr;
            g.strokeRect(x(s.start_seconds), dpr, Math.max(2, x(s.duration_seconds)), height - 2 * dpr);
        }
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
        this.source?.removeEventListener('audio-view-played', this.onPlayed);
        const id = this.getAttribute('for');
        this.source = id ? document.getElementById(id) : null;
        this.source?.addEventListener('audio-view-played', this.onPlayed);
    }
}

if (!customElements.get('vector-lane')) customElements.define('vector-lane', VectorLane);
