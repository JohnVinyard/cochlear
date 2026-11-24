import { useLayoutEffect, useRef } from 'react';
import type { VectorBars as VectorBarsElement } from './vector-bars';
import './vector-bars';

/** React wrapper for <vector-bars>: a vector as a small bar chart */
export const VectorBars = ({
    values,
    width,
    height,
    labels,
}: {
    values: number[];
    width?: number;
    height?: number;
    labels?: string[];
}) => {
    const ref = useRef<VectorBarsElement | null>(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const set = (name: string, v: string | undefined) => (v === undefined ? el.removeAttribute(name) : el.setAttribute(name, v));
        set('width', width === undefined ? undefined : String(width));
        set('height', height === undefined ? undefined : String(height));
        set('labels', labels ? JSON.stringify(labels) : undefined);
        el.values = values;
    }, [values, width, height, labels]);
    return <vector-bars ref={ref} />;
};
