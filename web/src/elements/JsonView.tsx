import { useLayoutEffect, useRef } from 'react';
import type { JsonView as JsonViewElement } from './json-view';
import './json-view';

/**
 * React wrapper for <json-view>: formatted, collapsible JSON on a dark
 * background. `lines` is how much shows before "show all"; `width` is any
 * CSS width.
 */
export const JsonView = ({ value, lines, width }: { value: unknown; lines?: number; width?: string }) => {
    const ref = useRef<JsonViewElement | null>(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        if (lines === undefined) el.removeAttribute('lines');
        else el.setAttribute('lines', String(lines));
        if (width === undefined) el.removeAttribute('width');
        else el.setAttribute('width', width);
        el.value = value;
    }, [value, lines, width]);
    return <json-view ref={ref} />;
};
