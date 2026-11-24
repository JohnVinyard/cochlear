/**
 * <json-view>: displays JSON, formatted and syntax-coloured, on a dark
 * background. It has a fixed width; long lines scroll sideways rather than
 * widening the page. Past a few lines it's collapsed, fading out, with a
 * toggle to show the rest.
 *
 * Attributes:
 *   value   the JSON, as text (or set the `value` property to any value)
 *   lines   how many lines to show while collapsed (default 8)
 *   width   any CSS width (default min(100%, 48rem))
 *
 * Styling: --json-view-background, --json-view-text, --json-view-key,
 * --json-view-string, --json-view-number, --json-view-literal.
 *
 * A vanilla custom element, in the style of <annotation-timeline>, so it can
 * be upstreamed to web-components with it.
 */

import { formatJson } from './formatJson';

const LINE_HEIGHT_PX = 18;

export class JsonView extends HTMLElement {
    static get observedAttributes() {
        return ['value', 'lines', 'width'];
    }

    private _value: unknown = undefined;
    private expanded = false;

    constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = `
            <style>
                :host {
                    display: block;
                    width: min(100%, 48rem);
                    --bg: var(--json-view-background, #1a1a19);
                    font: 12px/${LINE_HEIGHT_PX}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                }
                /* color-scheme: dark gives scrollbars (and other native bits) dark styling */
                .box { position: relative; color-scheme: dark; background: var(--bg); color: var(--json-view-text, #e6e4dd);
                       border-radius: 6px; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08); }
                .code { position: relative; }
                pre { margin: 0; padding: 8px 10px; overflow-x: auto; overflow-y: hidden; white-space: pre; tab-size: 2;
                      scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.25) transparent; }
                /* collapsed: no sideways scrolling (expand to see the rest), so the fade covers only text */
                pre.collapsed { overflow-x: hidden; }
                .key { color: var(--json-view-key, #8fb8ff); }
                .string { color: var(--json-view-string, #a8d9a0); }
                .number { color: var(--json-view-number, #f2b36b); }
                .literal { color: var(--json-view-literal, #d99bd6); }
                .fade { position: absolute; left: 0; right: 0; bottom: 0; height: ${LINE_HEIGHT_PX * 2}px; pointer-events: none;
                        background: linear-gradient(transparent, var(--bg)); }
                .bar { display: flex; justify-content: space-between; gap: 8px; padding: 0 10px 6px; }
                button { font: inherit; font-size: 11px; color: #b8b6ae; background: none; border: 0; padding: 0;
                         cursor: pointer; }
                button:hover { color: #f0efec; text-decoration: underline; }
                .copy { position: absolute; top: 6px; right: 8px; opacity: 0; transition: opacity .15s;
                        background: var(--bg); padding: 0 4px; }
                .box:hover .copy, .copy:focus { opacity: 1; }
                [hidden] { display: none !important; }
            </style>
            <div class="box">
                <div class="code"><pre></pre><div class="fade" hidden></div></div>
                <button class="copy" type="button" title="Copy as JSON">copy</button>
                <div class="bar" hidden><button class="toggle" type="button" aria-expanded="false"></button></div>
            </div>`;
        root.querySelector('.toggle')!.addEventListener('click', () => {
            this.expanded = !this.expanded;
            this.render();
        });
        const copy = root.querySelector<HTMLButtonElement>('.copy')!;
        copy.addEventListener('click', async () => {
            await navigator.clipboard.writeText(JSON.stringify(this._value, null, 2));
            copy.textContent = 'copied';
            setTimeout(() => (copy.textContent = 'copy'), 1200);
        });
    }

    get value(): unknown {
        return this._value;
    }
    set value(v: unknown) {
        this._value = v;
        this.expanded = false;
        this.render();
    }

    connectedCallback() {
        this.render();
    }

    attributeChangedCallback(name: string, _old: string | null, next: string | null) {
        if (name === 'value') {
            try {
                this._value = next === null ? undefined : JSON.parse(next);
            } catch {
                this._value = next; // not JSON: show it as a string
            }
            this.expanded = false;
        }
        if (name === 'width') this.style.width = next ?? '';
        this.render();
    }

    private get collapsedLines(): number {
        const n = Number(this.getAttribute('lines'));
        return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 8;
    }

    private render() {
        const root = this.shadowRoot!;
        const pre = root.querySelector('pre')!;
        const html = formatJson(this._value);
        pre.innerHTML = html;
        const total = html.split('\n').length;
        const collapsible = total > this.collapsedLines + 1; // never hide just one line
        const collapsed = collapsible && !this.expanded;
        // the top padding (8px) and the visible lines; collapsed, there is no horizontal scrollbar
        pre.style.maxHeight = collapsed ? `${8 + this.collapsedLines * LINE_HEIGHT_PX}px` : '';
        pre.classList.toggle('collapsed', collapsed);
        root.querySelector<HTMLElement>('.fade')!.hidden = !collapsed;
        root.querySelector<HTMLElement>('.bar')!.hidden = !collapsible;
        const toggle = root.querySelector<HTMLButtonElement>('.toggle')!;
        toggle.textContent = collapsed ? `▾ show all ${total} lines` : '▴ show less';
        toggle.setAttribute('aria-expanded', String(!collapsed));
    }
}

if (!customElements.get('json-view')) customElements.define('json-view', JsonView);
