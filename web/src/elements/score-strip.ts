/**
 * <score-strip>: timed events scrolling past, like a piano roll: the last
 * few seconds, with "now" at the right edge, redrawn every frame. Each event
 * is a block as long as the span it played; each sound gets a lane (the most
 * recently played ones; the rest share a last lane). Hover a block for what
 * it was.
 *
 * Attributes:
 *   window-seconds   how much time is visible (default 30)
 *   height           in CSS pixels (default 44)
 *
 * Properties:
 *   events   [{ at (epoch ms), durationSeconds, lane (e.g. a sound id), label }]
 *
 * A vanilla custom element, like <annotation-timeline>.
 */

export interface StripEvent {
    at: number;
    durationSeconds: number;
    lane: string;
    label: string;
}

const MAX_LANES = 4;
const BLOCK = '#3987e5';
const BLOCK_NEW = '#f0efec';
const LANE_LINE = '#2c2c2a';
const MUTED = '#898781';

export class ScoreStrip extends HTMLElement {
    static get observedAttributes() {
        return ['window-seconds', 'height'];
    }

    private _events: StripEvent[] = [];
    private frame: number | null = null;
    private mouseX: number | null = null;
    private mouseY: number | null = null;

    constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = `
            <style>
                :host { display: block; position: relative; }
                canvas { display: block; width: 100%; }
                .tip { position: absolute; bottom: calc(100% + 4px); display: none; pointer-events: none;
                       white-space: nowrap; padding: 2px 6px; border-radius: 4px; transform: translateX(-50%);
                       font: 11px/1.3 system-ui, sans-serif; background: #2c2c2a; color: #f0efec;
                       box-shadow: 0 0 0 1px rgba(255,255,255,0.10); }
            </style>
            <canvas aria-hidden="true"></canvas><div class="tip"></div>`;
        const canvas = root.querySelector('canvas')!;
        canvas.addEventListener('mousemove', (e) => {
            const r = canvas.getBoundingClientRect();
            this.mouseX = e.clientX - r.left;
            this.mouseY = e.clientY - r.top;
        });
        canvas.addEventListener('mouseleave', () => {
            this.mouseX = this.mouseY = null;
        });
    }

    set events(events: StripEvent[]) {
        this._events = events;
    }

    connectedCallback() {
        const tick = () => {
            this.draw();
            this.frame = requestAnimationFrame(tick);
        };
        this.frame = requestAnimationFrame(tick);
    }

    disconnectedCallback() {
        if (this.frame !== null) cancelAnimationFrame(this.frame);
        this.frame = null;
    }

    private num(name: string, fallback: number) {
        const n = Number(this.getAttribute(name));
        return Number.isFinite(n) && n > 0 ? n : fallback;
    }

    private draw() {
        const canvas = this.shadowRoot!.querySelector('canvas')!;
        const tip = this.shadowRoot!.querySelector<HTMLElement>('.tip')!;
        const windowMs = this.num('window-seconds', 30) * 1000;
        const height = this.num('height', 44);
        const width = canvas.clientWidth || 600;
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
            canvas.style.height = `${height}px`;
        }
        const g = canvas.getContext('2d')!;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, width, height);

        const now = Date.now();
        const visible = this._events.filter((e) => e.at + e.durationSeconds * 1000 >= now - windowMs && e.at <= now);
        // lanes: the most recently played sounds get their own
        const recent: string[] = [];
        for (let i = visible.length - 1; i >= 0 && recent.length < MAX_LANES; i--) {
            if (!recent.includes(visible[i]!.lane)) recent.push(visible[i]!.lane);
        }
        const lanes = Math.max(1, Math.min(MAX_LANES, recent.length + (visible.some((e) => !recent.includes(e.lane)) ? 1 : 0)));
        const laneHeight = height / lanes;
        const laneOf = (e: StripEvent) => {
            const i = recent.indexOf(e.lane);
            return i < 0 ? lanes - 1 : Math.min(i, lanes - 1);
        };
        const x = (t: number) => width - ((now - t) / windowMs) * width;

        g.fillStyle = LANE_LINE;
        for (let i = 1; i < lanes; i++) g.fillRect(0, Math.round(i * laneHeight), width, 1);
        // a tick each second
        for (let s = Math.ceil((now - windowMs) / 1000) * 1000; s <= now; s += 1000) {
            g.fillRect(Math.round(x(s)), height - 3, 1, 3);
        }

        let hovered: StripEvent | null = null;
        for (const e of visible) {
            const left = x(e.at);
            const w = Math.max(2, (e.durationSeconds * 1000 * width) / windowMs);
            const top = laneOf(e) * laneHeight + 3;
            const h = Math.max(2, laneHeight - 6);
            // a flash of white as it's played, settling to blue
            const age = now - e.at;
            g.fillStyle = age < 300 ? BLOCK_NEW : BLOCK;
            g.beginPath();
            g.roundRect(left, top, Math.min(w, width - left + 1), h, 2);
            g.fill();
            if (
                this.mouseX !== null && this.mouseY !== null &&
                this.mouseX >= left - 2 && this.mouseX <= left + w + 2 && this.mouseY >= top && this.mouseY <= top + h
            ) {
                hovered = e;
            }
        }
        if (!visible.length) {
            g.fillStyle = MUTED;
            g.font = '12px system-ui, sans-serif';
            g.textBaseline = 'middle';
            g.fillText('Recording: play something, anywhere', 8, height / 2);
        }
        if (hovered && this.mouseX !== null) {
            const ago = ((now - hovered.at) / 1000).toFixed(1);
            tip.textContent = `${hovered.label} · ${ago}s ago`;
            tip.style.left = `${Math.min(Math.max(this.mouseX, 80), width - 80)}px`;
            tip.style.display = 'block';
        } else {
            tip.style.display = 'none';
        }
    }
}

if (!customElements.get('score-strip')) customElements.define('score-strip', ScoreStrip);
