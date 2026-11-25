/**
 * <codec-viewer>: explore and play a cochlea codec document. A vanilla
 * custom element in the style of https://github.com/JohnVinyard/web-components.
 *
 * Attributes:
 *   src         URL of a document to load
 *   max-depth   tree levels expanded initially (default 2); deeper nodes start collapsed
 *   wasm-src    the decoder (default /codec/cochlea_codec.wasm)
 *   base-url    for relative URIs in the document (default: `src`, else the page)
 *
 * Properties:
 *   document    a document (object or JSON string), instead of `src`. Setting it resets the view.
 *   maxDepth    reflects `max-depth`
 *   selection   the selected span of time, { start_seconds, end_seconds } or null
 *
 * Methods:
 *   play(path?, fromSeconds?, untilSeconds?), playSelection(), stop()
 *   update(document)   replaces the document but keeps the view (expanded nodes, the
 *                      selection, playback), e.g. for a document that grows as it's recorded
 *
 * Events:
 *   codec-loaded              detail: { description, modules }
 *   codec-error               detail: { path, message }
 *   codec-node-selected       detail: { path }
 *   codec-selection-changed   detail: { selection }  (as the user drags, and when it's set)
 *
 * The timeline draws every leaf node (sampler, gammatone, ...) at the time it
 * plays; click a bar to find its node, or empty space to play from there.
 * Drag across it to select a span of time (drag an edge of the selection to
 * adjust it); the toolbar plays or clears it.
 * Every node in the tree can be played on its own, in context. Selecting a
 * node that came from a `$ref` highlights everywhere its definition plays.
 */
import {
    CodecFailure,
    CodecRuntime,
    DEFAULT_WASM_URL,
    type NodeLayout,
    type OpenDocument,
    type Playback,
} from '../codec/runtime';

/** A span of document time */
export interface Selection {
    start_seconds: number;
    end_seconds: number;
}

const COMMON_KEYS = new Set(['type', 'label', 'meta']);
const CHILDREN_PAGE = 200;
const MAX_LANES = 48;
const TYPE_COLORS: Record<string, string> = { sequencer: '#8b8fa3', sampler: '#3b6fe0', 'org.cochlea.gammatone': '#d9822b' };
const EXTRA_COLORS = ['#2f9e72', '#b04ad0', '#c9453a', '#3aa6b9', '#9a7b20'];

const escape = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const colorFor = (type: string): string => {
    if (TYPE_COLORS[type]) return TYPE_COLORS[type];
    let hash = 0;
    for (const c of type) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
    return EXTRA_COLORS[hash % EXTRA_COLORS.length]!;
};

const seconds = (s: number) => (s < 60 ? `${s.toFixed(2)}s` : `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`);

/** RFC 6901 */
const resolvePointer = (doc: unknown, pointer: string): unknown =>
    pointer
        .split('/')
        .slice(1)
        .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
        .reduce<unknown>((v, key) => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined), doc);

/** Orders JSON Pointers by document position (numeric segments numerically) */
const comparePaths = (a: string, b: string): number => {
    const x = a.split('/');
    const y = b.split('/');
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
        if (x[i] === y[i]) continue;
        const [m, n] = [Number(x[i]), Number(y[i])];
        return Number.isNaN(m) || Number.isNaN(n) ? x[i]!.localeCompare(y[i]!) : m - n;
    }
    return x.length - y.length;
};

const describeUri = (uri: string): string => {
    if (uri.startsWith('data:')) {
        const mime = uri.slice(5, uri.indexOf(/[;,]/.exec(uri)?.[0] ?? ',')) || 'data';
        return `data:${mime} · ${(uri.length / 1024).toFixed(1)} KB`;
    }
    try {
        const u = new URL(uri, location.href);
        return decodeURIComponent(u.pathname.split('/').pop() || u.host);
    } catch {
        return uri;
    }
};

/** `#/defs/four-kicks` -> `four-kicks` */
const refName = (ref: string) => ref.replace(/^#\/defs\//, '');

const formatValue = (key: string, v: unknown, depth = 0): string => {
    if (v && typeof v === 'object' && typeof (v as { $ref?: unknown }).$ref === 'string') {
        return `↪ ${refName((v as { $ref: string }).$ref)}`;
    }
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(4)));
    if (typeof v === 'string') return key === 'url' || v.startsWith('data:') ? describeUri(v) : JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.length}]`;
    if (v && typeof v === 'object') {
        if (depth > 0) return '{…}';
        return `{ ${Object.entries(v)
            .map(([k, x]) => `${k}: ${formatValue(k, x, depth + 1)}`)
            .join(', ')} }`;
    }
    return String(v);
};

const STYLE = `
:host { display: block; font: inherit; color: inherit; }
[hidden] { display: none !important; }
.toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
button { font: inherit; cursor: pointer; border: 1px solid var(--border, #d0d4db); border-radius: 6px;
         background: var(--panel, #f6f7f9); color: inherit; padding: 2px 10px; }
button:hover { border-color: var(--accent, #3b6fe0); }
.status { color: var(--muted, #6b7280); }
.error { color: var(--danger, #d13b3b); white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 12px;
         border: 1px solid currentColor; border-radius: 6px; padding: 8px; margin: 8px 0; }
.timeline { position: relative; border: 1px solid var(--border, #d0d4db); border-radius: 6px; overflow: hidden;
            background: var(--panel, #f6f7f9); margin-bottom: 10px; }
canvas { display: block; width: 100%; cursor: crosshair; touch-action: pan-y; }
.ruler { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted, #6b7280); padding: 0 4px; }
.tree { font-size: 13px; }
.row { display: flex; gap: 6px; align-items: baseline; padding: 1px 4px; border-radius: 4px; cursor: default;
       white-space: nowrap; }
.row:hover { background: var(--panel, #f6f7f9); }
.row.selected { outline: 1px solid var(--accent, #3b6fe0); }
.toggle { width: 14px; display: inline-block; text-align: center; cursor: pointer; color: var(--muted, #6b7280); }
.type { font-weight: 600; }
.label { font-style: italic; }
.ref { font-size: 0.85em; color: var(--muted, #6b7280); border: 1px solid var(--border, #d0d4db);
       border-radius: 4px; padding: 0 4px; white-space: nowrap; }
.params { color: var(--muted, #6b7280); overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1; }
.time { color: var(--muted, #6b7280); font-variant-numeric: tabular-nums; font-size: 12px; }
.play { padding: 0 6px; font-size: 11px; line-height: 16px; }
.children { margin-left: 16px; border-left: 1px solid var(--border, #d0d4db); padding-left: 4px; }
.collapsed { color: var(--muted, #6b7280); cursor: pointer; font-size: 12px; }
.legend { display: inline-flex; gap: 10px; font-size: 12px; }
.selection { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; font-variant-numeric: tabular-nums; }
.selection .hint { color: var(--muted, #6b7280); }
button.clear { padding: 0 6px; line-height: 18px; }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 3px; vertical-align: -1px; }
`;

export class CodecViewer extends HTMLElement {
    static get observedAttributes() {
        return ['src', 'max-depth', 'wasm-src', 'base-url'];
    }

    private _document: unknown = null;
    private parsed: unknown = null;
    private open: OpenDocument | null = null;
    private error: string | null = null;
    private status = '';
    private selected: string | null = null;
    private expanded = new Map<string, boolean>();
    private shownChildren = new Map<string, number>();
    private parentOf = new Map<string, string | null>();
    private childrenOf = new Map<string, string[]>();
    private depthOf = new Map<string, number>();
    private lanes: NodeLayout[][] = [];
    private playback: Playback | null = null;
    private playingPath: string | null = null;
    private frame: number | null = null;
    private loadToken = 0;
    private resizeObserver = new ResizeObserver(() => this.drawTimeline());
    private _selection: Selection | null = null;
    /** While dragging on the timeline: the fixed end of the selection */
    private drag: { anchor: number; x0: number; moved: boolean } | null = null;
    /** A drag ends with a click, which mustn't also play or select a node */
    private suppressClick = false;
    /** When playing up to a time (the selection), where to stop */
    private stopAt: number | null = null;

    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this.shadowRoot!.innerHTML = `<style>${STYLE}</style>
            <div class="toolbar">
                <button data-action="play-all">▶ Play</button>
                <span class="selection">
                    <span class="hint">drag on the timeline to select</span>
                    <span class="range" hidden></span>
                    <button data-action="play-selection" hidden>▶ Play selection</button>
                    <button class="clear" data-action="clear-selection" title="Clear the selection" hidden>✕</button>
                </span>
                <span class="status"></span>
                <span class="legend"></span>
            </div>
            <div class="error" hidden></div>
            <div class="timeline" hidden><canvas></canvas><div class="ruler"></div></div>
            <div class="tree"></div>`;
        this.shadowRoot!.addEventListener('click', (e) => this.onClick(e as MouseEvent));
        const canvas = this.shadowRoot!.querySelector('canvas')!;
        canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e, canvas));
        canvas.addEventListener('pointermove', (e) => this.onPointerMove(e, canvas));
        canvas.addEventListener('pointerup', (e) => this.onPointerUp(e, canvas));
        canvas.addEventListener('pointercancel', () => (this.drag = null));
    }

    connectedCallback() {
        this.resizeObserver.observe(this);
        if (this.getAttribute('src') && this._document === null) this.load();
    }

    disconnectedCallback() {
        this.resizeObserver.disconnect();
        this.stop();
    }

    attributeChangedCallback(name: string, old: string | null, value: string | null) {
        if (old === value) return;
        if (name === 'max-depth') {
            this.expanded.clear();
            this.renderTree();
        } else if (name === 'src' && value && this.isConnected) {
            this._document = null;
            this.load();
        }
    }

    get maxDepth(): number {
        const n = Number(this.getAttribute('max-depth') ?? 2);
        return Number.isFinite(n) && n >= 0 ? n : 2;
    }

    set maxDepth(n: number) {
        this.setAttribute('max-depth', String(n));
    }

    get document(): unknown {
        return this._document;
    }

    set document(doc: unknown) {
        this._document = doc;
        this._selection = null;
        this.load();
    }

    update(doc: unknown) {
        this._document = doc;
        // nothing to keep the first time
        this.load(this.open !== null);
    }

    get selection(): Selection | null {
        return this._selection ? { ...this._selection } : null;
    }

    set selection(s: Selection | null) {
        this.setSelection(s && s.end_seconds > s.start_seconds ? { ...s } : null);
    }

    private get runtime() {
        return CodecRuntime.shared(this.getAttribute('wasm-src') ?? DEFAULT_WASM_URL);
    }

    private async load(keepView = false) {
        const token = ++this.loadToken;
        this.error = null;
        if (!keepView) {
            this.stop();
            this.open = null;
            this.selected = null;
            this.expanded.clear();
            this.shownChildren.clear();
            this.setStatus('Loading…');
            this.renderAll();
        }
        try {
            let doc = this._document;
            const src = this.getAttribute('src');
            if (doc === null && src) {
                const resp = await fetch(src);
                if (!resp.ok) throw new Error(`${src}: HTTP ${resp.status}`);
                doc = await resp.text();
            }
            if (doc === null) return this.setStatus('');
            this.parsed = typeof doc === 'string' ? JSON.parse(doc) : doc;
            const baseUrl = this.getAttribute('base-url') ?? (src ? new URL(src, location.href).href : location.href);
            const open = await this.runtime.open(this.parsed, {
                baseUrl,
                onProgress: (loaded, total) => {
                    if (token === this.loadToken && total) this.setStatus(`Loading audio: ${loaded} of ${total}…`);
                },
            });
            if (token !== this.loadToken) return;
            this.open = open;
            this.index(open);
            const d = open.description;
            if (this.selected && !open.node(this.selected)) this.selected = null;
            // a selection beyond the (new) end is clamped, or dropped
            const sel = this._selection;
            if (sel && (sel.start_seconds >= d.duration_seconds || sel.end_seconds > d.duration_seconds)) {
                this.setSelection(
                    sel.start_seconds >= d.duration_seconds ? null : { ...sel, end_seconds: d.duration_seconds }
                );
            }
            this.setStatus(
                `${seconds(d.duration_seconds)} · ${d.nodes.length} nodes · ${open.resources.length} resources · ` +
                    open.modules.map((m) => `${m.type}@${m.version}`).join(', ')
            );
            this.dispatchEvent(new CustomEvent('codec-loaded', { detail: { description: d, modules: open.modules } }));
        } catch (e) {
            if (token !== this.loadToken) return;
            const error = e instanceof CodecFailure ? e.error : { path: '', message: (e as Error).message };
            this.error = error.path ? `${error.path}\n${error.message}` : error.message;
            this.setStatus('');
            this.dispatchEvent(new CustomEvent('codec-error', { detail: error }));
        }
        this.renderAll();
    }

    private index(open: OpenDocument) {
        const nodes = open.description.nodes;
        const paths = new Set(nodes.map((n) => n.path));
        this.parentOf.clear();
        this.childrenOf.clear();
        this.depthOf.clear();
        for (const n of nodes) {
            let p = n.path;
            let parent: string | null = null;
            while (p.lastIndexOf('/') > 0) {
                p = p.slice(0, p.lastIndexOf('/'));
                if (paths.has(p)) {
                    parent = p;
                    break;
                }
            }
            this.parentOf.set(n.path, parent);
            if (parent) {
                const list = this.childrenOf.get(parent) ?? [];
                list.push(n.path);
                this.childrenOf.set(parent, list);
            }
        }
        for (const list of this.childrenOf.values()) list.sort(comparePaths);
        const depth = (path: string): number => {
            const known = this.depthOf.get(path);
            if (known !== undefined) return known;
            const parent = this.parentOf.get(path);
            const d = parent ? depth(parent) + 1 : 0;
            this.depthOf.set(path, d);
            return d;
        };
        nodes.forEach((n) => depth(n.path));

        // greedy lanes for leaves: each goes in the first lane that's free
        const leaves = nodes.filter((n) => !this.childrenOf.has(n.path)).sort((a, b) => a.start_seconds - b.start_seconds);
        const ends: number[] = [];
        this.lanes = [];
        for (const leaf of leaves) {
            let lane = ends.findIndex((end) => end <= leaf.start_seconds);
            if (lane === -1) lane = ends.length < MAX_LANES ? ends.length : ends.indexOf(Math.min(...ends));
            ends[lane] = leaf.start_seconds + leaf.duration_seconds;
            (this.lanes[lane] ??= []).push(leaf);
        }
    }

    // -- playback -------------------------------------------------------------

    /** Plays one node in context, or everything from `fromSeconds` (until `untilSeconds`, if given) */
    async play(path?: string, fromSeconds = 0, untilSeconds?: number) {
        if (!this.open) return;
        this.stop();
        try {
            const playback = await this.open.play({ path: path ?? '', fromSeconds });
            this.playback = playback;
            this.playingPath = path ?? null;
            this.stopAt = untilSeconds ?? null;
            this.renderToolbar();
            this.tick();
            playback.ended
                .catch((e) => {
                    this.error = e instanceof CodecFailure ? e.message : String(e);
                    this.renderAll();
                })
                .finally(() => {
                    if (this.playback === playback) this.stop();
                });
        } catch (e) {
            this.error = (e as Error).message;
            this.renderAll();
        }
    }

    playSelection() {
        const s = this._selection;
        if (s) return this.play(undefined, s.start_seconds, s.end_seconds);
    }

    stop() {
        const p = this.playback;
        this.playback = null;
        this.playingPath = null;
        this.stopAt = null;
        p?.stop();
        if (this.frame !== null) cancelAnimationFrame(this.frame);
        this.frame = null;
        this.renderToolbar();
        this.drawTimeline();
    }

    private tick() {
        if (this.playback && this.stopAt !== null && this.playback.position() >= this.stopAt) return this.stop();
        this.drawTimeline();
        if (this.playback) this.frame = requestAnimationFrame(() => this.tick());
    }

    // -- events -----------------------------------------------------------------

    private onClick(e: MouseEvent) {
        const target = e.target as HTMLElement;
        if (target instanceof HTMLCanvasElement) return this.onTimelineClick(e, target);
        const el = target.closest<HTMLElement>('[data-action]');
        if (!el) return;
        const path = el.dataset.path ?? '';
        switch (el.dataset.action) {
            case 'play-all':
                return this.playback ? this.stop() : this.play();
            case 'play-selection':
                return this.playback && this.stopAt !== null ? this.stop() : this.playSelection();
            case 'clear-selection':
                return this.setSelection(null);
            case 'play':
                return this.playingPath === path ? this.stop() : this.play(path);
            case 'toggle':
                this.expanded.set(path, !this.isExpanded(path));
                return this.renderTree();
            case 'more':
                this.shownChildren.set(path, (this.shownChildren.get(path) ?? CHILDREN_PAGE) + CHILDREN_PAGE * 5);
                return this.renderTree();
            case 'select':
                return this.select(path === this.selected ? null : path);
        }
    }

    /** The document time under the pointer, within the document */
    private timeAt(e: MouseEvent, canvas: HTMLCanvasElement): number {
        const rect = canvas.getBoundingClientRect();
        const duration = this.open?.description.duration_seconds ?? 0;
        return Math.min(Math.max(((e.clientX - rect.left) / rect.width) * duration, 0), duration);
    }

    /** Which edge of the selection (if any) is within a few pixels of the pointer */
    private edgeAt(e: MouseEvent, canvas: HTMLCanvasElement): 'start' | 'end' | null {
        const s = this._selection;
        const duration = this.open?.description.duration_seconds;
        if (!s || !duration) return null;
        const rect = canvas.getBoundingClientRect();
        const x = (t: number) => rect.left + (t / duration) * rect.width;
        if (Math.abs(e.clientX - x(s.start_seconds)) <= 5) return 'start';
        if (Math.abs(e.clientX - x(s.end_seconds)) <= 5) return 'end';
        return null;
    }

    private onPointerDown(e: PointerEvent, canvas: HTMLCanvasElement) {
        if (!this.open || e.button !== 0) return;
        const edge = this.edgeAt(e, canvas);
        const s = this._selection;
        // grabbing an edge moves it: the other one stays put
        const anchor = edge && s ? (edge === 'start' ? s.end_seconds : s.start_seconds) : this.timeAt(e, canvas);
        this.drag = { anchor, x0: e.clientX, moved: edge !== null };
        canvas.setPointerCapture(e.pointerId);
    }

    private onPointerMove(e: PointerEvent, canvas: HTMLCanvasElement) {
        if (!this.drag) {
            canvas.style.cursor = this.edgeAt(e, canvas) ? 'ew-resize' : '';
            return;
        }
        if (!this.drag.moved && Math.abs(e.clientX - this.drag.x0) < 4) return;
        this.drag.moved = true;
        const t = this.timeAt(e, canvas);
        const { anchor } = this.drag;
        this.setSelection({ start_seconds: Math.min(anchor, t), end_seconds: Math.max(anchor, t) });
    }

    private onPointerUp(e: PointerEvent, canvas: HTMLCanvasElement) {
        const drag = this.drag;
        this.drag = null;
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
        if (!drag?.moved) return;
        this.suppressClick = true;
        const s = this._selection;
        if (s && s.end_seconds - s.start_seconds < 1e-3) this.setSelection(null);
    }

    private setSelection(s: Selection | null, notify = true) {
        const old = this._selection;
        if (old?.start_seconds === s?.start_seconds && old?.end_seconds === s?.end_seconds) return;
        this._selection = s;
        // a selection that's playing stops where the selection now ends
        if (this.playback && this.stopAt !== null) this.stopAt = s?.end_seconds ?? null;
        this.renderSelection();
        this.drawTimeline();
        if (notify) this.dispatchEvent(new CustomEvent('codec-selection-changed', { detail: { selection: this.selection } }));
    }

    private onTimelineClick(e: MouseEvent, canvas: HTMLCanvasElement) {
        if (this.suppressClick) {
            this.suppressClick = false;
            return;
        }
        if (!this.open) return;
        const rect = canvas.getBoundingClientRect();
        const t = ((e.clientX - rect.left) / rect.width) * this.open.description.duration_seconds;
        const laneHeight = rect.height / Math.max(this.lanes.length, 1);
        const lane = this.lanes[Math.floor((e.clientY - rect.top) / laneHeight)] ?? [];
        const slop = (4 / rect.width) * this.open.description.duration_seconds;
        const hit = lane.find((n) => t >= n.start_seconds - slop && t <= n.start_seconds + n.duration_seconds + slop);
        if (hit) this.select(hit.path, true);
        else this.play(undefined, t);
    }

    private select(path: string | null, reveal = false) {
        this.selected = path;
        if (path && reveal) {
            for (let p = this.parentOf.get(path); p; p = this.parentOf.get(p)) this.expanded.set(p, true);
        }
        this.renderTree();
        this.drawTimeline();
        if (path && reveal) {
            this.shadowRoot!.querySelector(`.row[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'nearest' });
        }
        this.dispatchEvent(new CustomEvent('codec-node-selected', { detail: { path } }));
    }

    // -- rendering ----------------------------------------------------------------

    private setStatus(s: string) {
        this.status = s;
        const el = this.shadowRoot!.querySelector('.status');
        if (el) el.textContent = s;
    }

    private renderAll() {
        const root = this.shadowRoot!;
        const error = root.querySelector<HTMLElement>('.error')!;
        error.hidden = !this.error;
        error.textContent = this.error ?? '';
        root.querySelector<HTMLElement>('.timeline')!.hidden = !this.open;
        const types = [...new Set(this.open?.description.nodes.map((n) => n.type) ?? [])];
        root.querySelector('.legend')!.innerHTML = types
            .map((t) => `<span><span class="swatch" style="background:${colorFor(t)}"></span>${escape(t)}</span>`)
            .join('');
        this.setStatus(this.status);
        this.renderToolbar();
        this.renderSelection();
        this.renderTree();
        this.drawTimeline();
    }

    private renderSelection() {
        const root = this.shadowRoot!;
        const s = this._selection;
        root.querySelector<HTMLElement>('.selection')!.hidden = !this.open;
        root.querySelector<HTMLElement>('.selection .hint')!.hidden = !!s;
        const range = root.querySelector<HTMLElement>('.selection .range')!;
        range.hidden = !s;
        range.textContent = s
            ? `${seconds(s.start_seconds)}–${seconds(s.end_seconds)} (${seconds(s.end_seconds - s.start_seconds)})`
            : '';
        root.querySelector<HTMLElement>('[data-action="play-selection"]')!.hidden = !s;
        root.querySelector<HTMLElement>('[data-action="clear-selection"]')!.hidden = !s;
        this.renderToolbar();
    }

    private renderToolbar() {
        const button = this.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="play-all"]')!;
        button.disabled = !this.open;
        button.textContent = this.playback ? '■ Stop' : '▶ Play';
        const selection = this.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="play-selection"]')!;
        selection.textContent = this.playback && this.stopAt !== null ? '■ Stop' : '▶ Play selection';
        this.shadowRoot!.querySelectorAll<HTMLElement>('[data-action="play"]').forEach((b) => {
            b.textContent = b.dataset.path === this.playingPath ? '■' : '▶';
        });
    }

    private isExpanded(path: string): boolean {
        return this.expanded.get(path) ?? (this.depthOf.get(path) ?? 0) < this.maxDepth;
    }

    private renderTree() {
        const tree = this.shadowRoot!.querySelector('.tree')!;
        if (!this.open) {
            tree.innerHTML = '';
            return;
        }
        tree.innerHTML = this.renderNode('/root');
        this.renderToolbar();
    }

    private renderNode(path: string): string {
        const layout = this.open!.node(path);
        const json = resolvePointer(this.parsed, layout?.source ?? path) as Record<string, unknown> | undefined;
        if (!layout || !json) return '';
        const children = this.childrenOf.get(path) ?? [];
        const expanded = this.isExpanded(path);
        const params = Object.entries(json)
            .filter(([k]) => !COMMON_KEYS.has(k))
            .map(([k, v]) => {
                const prefix = `${path}/${k}`;
                const nested = children.filter((c) => c === prefix || c.startsWith(`${prefix}/`)).length;
                return nested ? `${k}: ${nested}` : `${k}: ${formatValue(k, v)}`;
            })
            .join(' · ');
        const end = layout.start_seconds + layout.duration_seconds;
        const row = `<div class="row${path === this.selected ? ' selected' : ''}" data-action="select" data-path="${escape(path)}">
            <span class="toggle" ${children.length ? `data-action="toggle" data-path="${escape(path)}"` : ''}>${
                children.length ? (expanded ? '▾' : '▸') : '·'
            }</span>
            <button class="play" data-action="play" data-path="${escape(path)}" title="Play this node in context">▶</button>
            <span class="type" style="color:${colorFor(layout.type)}">${escape(layout.type)}</span>
            ${layout.label ? `<span class="label">${escape(layout.label)}</span>` : ''}
            ${layout.reference ? `<span class="ref" title="${escape(`defined at ${layout.source}`)}">↪ ${escape(refName(layout.reference))}</span>` : ''}
            <span class="time">${seconds(layout.start_seconds)}–${seconds(end)}</span>
            <span class="params" title="${escape(params)}">${escape(params)}</span>
        </div>`;
        if (!children.length) return row;
        if (!expanded) {
            return `${row}<div class="children"><span class="collapsed" data-action="toggle" data-path="${escape(path)}">${
                children.length
            } node${children.length === 1 ? '' : 's'}…</span></div>`;
        }
        const limit = this.shownChildren.get(path) ?? CHILDREN_PAGE;
        const shown = children.slice(0, limit).map((c) => this.renderNode(c)).join('');
        const more =
            children.length > limit
                ? `<span class="collapsed" data-action="more" data-path="${escape(path)}">show more (${children.length - limit} hidden)</span>`
                : '';
        return `${row}<div class="children">${shown}${more}</div>`;
    }

    private drawTimeline() {
        const canvas = this.shadowRoot!.querySelector('canvas')!;
        const ruler = this.shadowRoot!.querySelector('.ruler')!;
        if (!this.open) return;
        const duration = Math.max(this.open.description.duration_seconds, 1e-6);
        const lanes = Math.max(this.lanes.length, 1);
        const laneHeight = Math.max(3, Math.min(14, Math.floor(160 / lanes)));
        const width = canvas.clientWidth || this.clientWidth || 600;
        const height = lanes * laneHeight;
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
            canvas.style.height = `${height}px`;
        }
        const g = canvas.getContext('2d')!;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, width, height);
        const within = (p: string, root: string) => p === root || p.startsWith(`${root}/`);
        // selecting something that was defined once (in defs) highlights everywhere it plays
        const source = this.selected ? this.open.node(this.selected)?.source : undefined;
        const shared = source?.startsWith('/defs/') ? source : undefined;
        const inSelection = (n: NodeLayout) =>
            !this.selected || within(n.path, this.selected) || (shared !== undefined && within(n.source, shared));
        this.lanes.forEach((lane, i) => {
            for (const n of lane) {
                g.globalAlpha = inSelection(n) ? 0.9 : 0.15;
                g.fillStyle = colorFor(n.type);
                const x = (n.start_seconds / duration) * width;
                const w = Math.max(1.5, (n.duration_seconds / duration) * width);
                g.fillRect(x, i * laneHeight + 1, w, laneHeight - 2);
            }
        });
        g.globalAlpha = 1;
        const sel = this._selection;
        if (sel) {
            const x0 = (sel.start_seconds / duration) * width;
            const x1 = (sel.end_seconds / duration) * width;
            g.fillStyle = getComputedStyle(this).getPropertyValue('--accent').trim() || '#3b6fe0';
            g.globalAlpha = 0.18;
            g.fillRect(x0, 0, x1 - x0, height);
            g.globalAlpha = 0.9;
            g.fillRect(x0 - 0.75, 0, 1.5, height);
            g.fillRect(x1 - 0.75, 0, 1.5, height);
            g.globalAlpha = 1;
        }
        if (this.playback) {
            const x = (this.playback.position() / duration) * width;
            g.fillStyle = getComputedStyle(this).getPropertyValue('--danger').trim() || '#d13b3b';
            g.fillRect(x, 0, 1.5, height);
        }
        ruler.innerHTML = [0, 0.25, 0.5, 0.75, 1].map((f) => `<span>${seconds(f * duration)}</span>`).join('');
    }
}

if (!customElements.get('codec-viewer')) customElements.define('codec-viewer', CodecViewer);
