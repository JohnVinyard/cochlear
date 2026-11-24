/**
 * <annotation-timeline>:  displays time-sliced annotations as lanes of
 * segments under an <audio-view>.  A vanilla custom element in the style of
 * https://github.com/JohnVinyard/web-components, intended to be upstreamed
 * there.
 *
 * Attributes (strings, like <audio-view>):
 *   duration      total duration of the sound, in seconds
 *   annotations   JSON: [{ id, start_seconds, duration_seconds, label }]
 *   for           id of an <audio-view> element;  its `audio-view-played`
 *                 events drive a playhead
 *
 * Events:
 *   annotation-selected   detail: { id, startSeconds, durationSeconds }
 *
 * PLACEHOLDER:  no zoom/scroll sync with <audio-view> yet.
 */

interface TimelineAnnotation {
    id: number;
    start_seconds: number;
    duration_seconds: number;
    label: string;
}

const LANE_HEIGHT_PX = 22;

/** Greedy interval partitioning:  each segment goes in the first lane it fits */
export const assignLanes = (items: TimelineAnnotation[]): TimelineAnnotation[][] => {
    const lanes: { end: number; items: TimelineAnnotation[] }[] = [];
    for (const item of [...items].sort((a, b) => a.start_seconds - b.start_seconds)) {
        const lane = lanes.find((l) => l.end <= item.start_seconds);
        const end = item.start_seconds + item.duration_seconds;
        if (lane) {
            lane.items.push(item);
            lane.end = end;
        } else {
            lanes.push({ end, items: [item] });
        }
    }
    return lanes.map((l) => l.items);
};

export class AnnotationTimeline extends HTMLElement {
    static get observedAttributes() {
        return ['duration', 'annotations', 'for'];
    }

    private playhead: HTMLElement | null = null;
    private playheadFrame: number | null = null;
    private source: HTMLElement | null = null;

    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
    }

    connectedCallback() {
        this.render();
        this.bindSource();
    }

    disconnectedCallback() {
        this.unbindSource();
        if (this.playheadFrame !== null) cancelAnimationFrame(this.playheadFrame);
    }

    attributeChangedCallback(name: string) {
        if (name === 'for') this.bindSource();
        this.render();
    }

    private get duration(): number {
        const d = Number(this.getAttribute('duration'));
        return Number.isFinite(d) && d > 0 ? d : 1;
    }

    private get annotations(): TimelineAnnotation[] {
        try {
            const parsed = JSON.parse(this.getAttribute('annotations') ?? '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    private readonly onPlayed = (e: Event) => {
        const { startSeconds, durationSeconds } = (e as CustomEvent).detail;
        this.animatePlayhead(startSeconds, durationSeconds);
    };

    private bindSource() {
        this.unbindSource();
        const id = this.getAttribute('for');
        this.source = id ? (this.getRootNode() as Document | ShadowRoot).getElementById?.(id) ?? document.getElementById(id) : null;
        this.source?.addEventListener('audio-view-played', this.onPlayed);
    }

    private unbindSource() {
        this.source?.removeEventListener('audio-view-played', this.onPlayed);
        this.source = null;
    }

    private animatePlayhead(start: number, duration: number) {
        if (this.playheadFrame !== null) cancelAnimationFrame(this.playheadFrame);
        const began = performance.now();
        const tick = () => {
            const elapsed = (performance.now() - began) / 1000;
            const head = this.playhead;
            if (!head) return;
            if (elapsed > duration) {
                head.style.display = 'none';
                this.playheadFrame = null;
                return;
            }
            head.style.display = 'block';
            head.style.left = `${((start + elapsed) / this.duration) * 100}%`;
            this.playheadFrame = requestAnimationFrame(tick);
        };
        this.playheadFrame = requestAnimationFrame(tick);
    }

    private render() {
        const root = this.shadowRoot!;
        const lanes = assignLanes(this.annotations);
        const pct = (seconds: number) => `${(seconds / this.duration) * 100}%`;
        root.innerHTML = `
            <style>
                :host { display: block; position: relative; font: 11px/1 system-ui, sans-serif; }
                .lanes { position: relative; height: ${Math.max(1, lanes.length) * LANE_HEIGHT_PX}px;
                         background: var(--annotation-timeline-background, rgba(127,127,127,0.08)); }
                .segment { position: absolute; height: ${LANE_HEIGHT_PX - 4}px; box-sizing: border-box;
                           padding: 3px 4px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
                           cursor: pointer; border-radius: 3px; min-width: 3px;
                           background: var(--annotation-timeline-segment, #5b8def); color: #fff; }
                .segment:hover { filter: brightness(1.15); }
                .playhead { position: absolute; top: 0; bottom: 0; width: 1px; display: none;
                            background: var(--annotation-timeline-playhead, #e5484d); pointer-events: none; }
                .empty { position: absolute; inset: 0; display: flex; align-items: center; padding-left: 6px; opacity: .6; }
            </style>
            <div class="lanes">
                ${lanes.length ? '' : '<div class="empty">No time-sliced annotations</div>'}
                <div class="playhead"></div>
            </div>`;
        const container = root.querySelector('.lanes')!;
        lanes.forEach((lane, i) => {
            for (const a of lane) {
                const el = document.createElement('div');
                el.className = 'segment';
                el.style.left = pct(a.start_seconds);
                el.style.width = pct(a.duration_seconds);
                el.style.top = `${i * LANE_HEIGHT_PX + 2}px`;
                el.title = `${a.label} (${a.start_seconds.toFixed(2)}s – ${(a.start_seconds + a.duration_seconds).toFixed(2)}s)`;
                el.textContent = a.label;
                el.addEventListener('click', (e) =>
                    this.dispatchEvent(
                        new CustomEvent('annotation-selected', {
                            bubbles: true,
                            composed: true,
                            detail: {
                                id: a.id,
                                startSeconds: a.start_seconds,
                                durationSeconds: a.duration_seconds,
                                timeStamp: e.timeStamp,
                            },
                        })
                    )
                );
                container.appendChild(el);
            }
        });
        this.playhead = root.querySelector('.playhead');
    }
}

if (!customElements.get('annotation-timeline')) {
    customElements.define('annotation-timeline', AnnotationTimeline);
}
