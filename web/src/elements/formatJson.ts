/** Pretty-printed JSON, as HTML with a span per token, for <json-view> */

export const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const INDENT = '  ';

/**
 * Formats a value as indented JSON, in HTML, with a span per token. Built
 * from the value itself (not by colouring JSON.stringify's output), so it's
 * always well-formed, and every string is escaped.
 */
export const formatJson = (value: unknown, indent = ''): string => {
    if (value === null || value === undefined) return '<span class="literal">null</span>';
    if (typeof value === 'boolean') return `<span class="literal">${value}</span>`;
    if (typeof value === 'number') {
        return Number.isFinite(value) ? `<span class="number">${value}</span>` : '<span class="literal">null</span>';
    }
    if (typeof value === 'string') return `<span class="string">${escapeHtml(JSON.stringify(value))}</span>`;
    const inner = indent + INDENT;
    if (Array.isArray(value)) {
        if (!value.length) return '[]';
        return `[\n${value.map((v) => inner + formatJson(v, inner)).join(',\n')}\n${indent}]`;
    }
    if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
        if (!entries.length) return '{}';
        const items = entries.map(
            ([k, v]) => `${inner}<span class="key">${escapeHtml(JSON.stringify(k))}</span>: ${formatJson(v, inner)}`
        );
        return `{\n${items.join(',\n')}\n${indent}}`;
    }
    return escapeHtml(JSON.stringify(String(value)));
};
