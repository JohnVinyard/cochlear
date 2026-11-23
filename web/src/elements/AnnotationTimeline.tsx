import type { AnnotationResource } from '@cochlea/shared';
import { useLayoutEffect, useRef } from 'react';
import './annotation-timeline';

export const annotationLabel = (a: AnnotationResource): string => {
    if (a.tags) return a.tags.join(', ');
    if (a.text) return a.text;
    if (a.kv) return JSON.stringify(a.kv);
    if (a.vector) return `${a.schema} [${a.vector.length}]`;
    if (a.blob) return `${a.schema} (blob)`;
    return a.schema;
};

/** React wrapper for <annotation-timeline>;  sets attributes, like AudioView */
export const AnnotationTimeline = ({
    duration,
    annotations,
    audioViewId,
    onSelected,
}: {
    duration: number;
    annotations: AnnotationResource[];
    audioViewId: string;
    onSelected: (annotation: AnnotationResource) => void;
}) => {
    const ref = useRef<HTMLElement | null>(null);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const segments = annotations
            .filter((a) => a.start_seconds !== null && a.duration_seconds !== null)
            .map((a) => ({
                id: a.id,
                start_seconds: a.start_seconds,
                duration_seconds: a.duration_seconds,
                label: annotationLabel(a),
            }));
        el.setAttribute('duration', String(duration));
        el.setAttribute('annotations', JSON.stringify(segments));
        el.setAttribute('for', audioViewId);
    }, [duration, annotations, audioViewId]);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const handler = (e: CustomEvent<{ id: number }>) => {
            const a = annotations.find((x) => x.id === e.detail.id);
            if (a) onSelected(a);
        };
        el.addEventListener('annotation-selected', handler);
        return () => el.removeEventListener('annotation-selected', handler);
    }, [annotations, onSelected]);

    return <annotation-timeline ref={ref} />;
};
