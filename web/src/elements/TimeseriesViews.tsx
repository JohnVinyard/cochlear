import { type AnnotationResource, type SoundResource, type TimeseriesData, timeseriesOf } from '@cochlea/shared';
import { useLayoutEffect, useRef } from 'react';
import { useFeed } from '../api';
import type { TimeseriesView as TimeseriesViewElement } from './timeseries-view';
import './timeseries-view';

/** React wrapper for <timeseries-view>; sets attributes, like AudioView */
export const TimeseriesView = ({
    annotation,
    timeseries,
    duration,
    audioViewId,
    onSelected,
}: {
    annotation: AnnotationResource;
    timeseries: TimeseriesData;
    duration: number;
    audioViewId: string;
    onSelected: (seconds: number, timeStamp?: number) => void;
}) => {
    const ref = useRef<TimeseriesViewElement | null>(null);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const set = (name: string, value: unknown) =>
            value === undefined || value === null
                ? el.removeAttribute(name)
                : el.setAttribute(name, typeof value === 'string' ? value : JSON.stringify(value));
        set('src', annotation.blob!.url);
        set('array', timeseries.array);
        set('frame-rate', String(timeseries.frame_rate));
        set('start-seconds', String((annotation.start_seconds ?? 0) + (timeseries.start_seconds ?? 0)));
        set('duration', String(duration));
        set('rows', timeseries.rows);
        set('range', timeseries.range);
        set('normalize', timeseries.normalize);
        set('label', `${annotation.schema} · user ${annotation.created_by}`);
        set('for', audioViewId);
    }, [annotation, timeseries, duration, audioViewId]);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const handler = (e: Event) => {
            const { seconds, timeStamp } = (e as CustomEvent<{ seconds: number; timeStamp?: number }>).detail;
            onSelected(seconds, timeStamp);
        };
        el.addEventListener('timeseries-selected', handler);
        return () => el.removeEventListener('timeseries-selected', handler);
    }, [onSelected]);

    return <timeseries-view ref={ref} />;
};

/**
 * Every blob annotation on a sound that follows the time series convention
 * (docs/annotation-conventions.md), drawn under its waveform
 */
export const SoundTimeseries = ({
    sound,
    audioViewId,
    onSelected,
}: {
    sound: SoundResource;
    audioViewId: string;
    onSelected: (seconds: number, timeStamp?: number) => void;
}) => {
    const blobs = useFeed<AnnotationResource>(`${sound.links.annotations}?kind=blob&page_size=500`);
    const series = blobs.items.flatMap((a) => {
        const t = timeseriesOf(a);
        return t ? [{ annotation: a, timeseries: t }] : [];
    });
    if (!series.length) return null;
    return (
        <div className="timeseries">
            {series.map(({ annotation, timeseries }) => (
                <TimeseriesView
                    key={annotation.id}
                    annotation={annotation}
                    timeseries={timeseries}
                    duration={sound.duration_seconds}
                    audioViewId={audioViewId}
                    onSelected={onSelected}
                />
            ))}
        </div>
    );
};
