import type { AnnotationResource, Page, SimilarAnnotationsResource, SoundResource } from '@cochlea/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, type ApiError } from '../api';
import { ApiLink, ErrorMessage } from '../components';
import type { Scatter3d, ScatterPoint } from '../elements/scatter-3d';
import '../elements/scatter-3d';
import type { LaneSegment, VectorLane as VectorLaneElement } from '../elements/vector-lane';
import '../elements/vector-lane';
import { SegmentPlayer } from '../audio/segments';
import { pcaColors } from './pca';

/**
 * Vector annotations on the sound page: a lane per vector schema (coloured by
 * principal components), and, for a selected segment, its nearest neighbours
 * (GET /annotations/{id}/similar), laid out in 3-d with t-SNE. Works for any
 * vector schema: each has its own index.
 */

const player = new SegmentPlayer();

/** Longest bit of a search result to play: onset segments are short, but the last one runs to the end */
const MAX_PLAY_SECONDS = 5;

/** Every page of a feed */
const useAll = <T,>(href: string) => {
    const [items, setItems] = useState<T[]>([]);
    const [error, setError] = useState<ApiError | null>(null);
    useEffect(() => {
        let cancelled = false;
        setItems([]);
        (async () => {
            let next: string | undefined = href;
            const all: T[] = [];
            while (next && !cancelled) {
                const page: Page<T> = await api<Page<T>>(next);
                all.push(...page.items);
                next = page.next;
            }
            if (!cancelled) setItems(all);
        })().catch((e) => !cancelled && setError(e));
        return () => {
            cancelled = true;
        };
    }, [href]);
    return { items, error };
};

const VectorLane = ({
    label,
    segments,
    duration,
    audioViewId,
    selected,
    onSelected,
}: {
    label: string;
    segments: LaneSegment[];
    duration: number;
    audioViewId: string;
    selected: number | null;
    onSelected: (id: number) => void;
}) => {
    const ref = useRef<VectorLaneElement | null>(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.setAttribute('duration', String(duration));
        el.setAttribute('label', label);
        el.setAttribute('for', audioViewId);
        el.segments = segments;
    }, [duration, label, audioViewId, segments]);
    useLayoutEffect(() => {
        if (ref.current) ref.current.selected = selected;
    }, [selected]);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const handler = (e: Event) => onSelected((e as CustomEvent<{ id: number }>).detail.id);
        el.addEventListener('segment-selected', handler);
        return () => el.removeEventListener('segment-selected', handler);
    }, [onSelected]);
    return <vector-lane ref={ref} />;
};

/** One lane per vector schema on the sound */
export const VectorLanes = ({
    sound,
    audioViewId,
    selected,
    onSelected,
}: {
    sound: SoundResource;
    audioViewId: string;
    selected: AnnotationResource | null;
    onSelected: (a: AnnotationResource) => void;
}) => {
    const { items, error } = useAll<AnnotationResource>(`${sound.links.annotations}?kind=vector&page_size=500`);
    const lanes = useMemo(() => {
        const bySchema = new Map<string, AnnotationResource[]>();
        for (const a of items) {
            if (a.vector && a.start_seconds !== null && a.duration_seconds !== null) {
                bySchema.set(a.schema, [...(bySchema.get(a.schema) ?? []), a]);
            }
        }
        return [...bySchema].map(([schema, annotations]) => {
            const colours = pcaColors(annotations.map((a) => a.vector!));
            const segments: LaneSegment[] = annotations.map((a, i) => ({
                id: a.id,
                start_seconds: a.start_seconds!,
                duration_seconds: a.duration_seconds!,
                color: colours[i]!,
            }));
            return { schema, annotations, segments };
        });
    }, [items]);
    const byId = useMemo(() => new Map<number, AnnotationResource>(items.map((a) => [a.id, a])), [items]);
    const select = useCallback(
        (id: number) => {
            const a = byId.get(id);
            if (a) onSelected(a);
        },
        [byId, onSelected]
    );

    return (
        <>
            <ErrorMessage error={error} />
            {lanes.map(({ schema, annotations, segments }) => (
                <VectorLane
                    key={schema}
                    label={`${schema} · ${annotations.length} segments, coloured by their principal components`}
                    segments={segments}
                    duration={sound.duration_seconds}
                    audioViewId={audioViewId}
                    selected={selected?.schema === schema ? selected.id : null}
                    onSelected={select}
                />
            ))}
        </>
    );
};

type Result = SimilarAnnotationsResource['items'][number];

type Rgb = [number, number, number];
const hex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;

/**
 * Colour by sound, for the dark plot. In a scatterplot any two colours can
 * end up side by side, and only three categorical colours stay distinct for
 * every pair (colour-blind readers included; validated against #1a1a19), so
 * the three sounds with the most points get them, and the rest are "other".
 * Hovering a point highlights its whole sound, which identifies the rest.
 */
const SOUND_COLOURS = ['#3987e5', '#d95926', '#199e70'].map(hex);
const OTHER_COLOUR = hex('#6b6a65');
const QUERY_COLOUR = hex('#f0efec');

interface Key {
    colourOf: (r: Result) => Rgb;
    legend: { colour: Rgb; label: string }[];
}

const colourKey = (results: Result[], queryId: number): Key => {
    const bySound = new Map<number, { sound: Result['sound']; count: number; nearest: number }>();
    for (const r of results) {
        if (r.annotation.id === queryId) continue;
        const e = bySound.get(r.sound.id) ?? { sound: r.sound, count: 0, nearest: Infinity };
        e.count++;
        e.nearest = Math.min(e.nearest, r.distance);
        bySound.set(r.sound.id, e);
    }
    // most points first; ties go to the sound with the nearer segment
    const ranked = [...bySound.values()].sort((a, b) => b.count - a.count || a.nearest - b.nearest);
    const coloured = new Map(ranked.slice(0, SOUND_COLOURS.length).map((e, i) => [e.sound.id, SOUND_COLOURS[i]!]));
    const others = ranked.slice(SOUND_COLOURS.length);
    const title = (s: Result['sound']) => s.title ?? `sound ${s.id}`;
    return {
        colourOf: (r) => (r.annotation.id === queryId ? QUERY_COLOUR : coloured.get(r.sound.id) ?? OTHER_COLOUR),
        legend: [
            { colour: QUERY_COLOUR, label: 'the query segment' },
            ...ranked.slice(0, SOUND_COLOURS.length).map((e) => ({
                colour: coloured.get(e.sound.id)!,
                label: `${title(e.sound)} (${e.count})`,
            })),
            ...(others.length
                ? [{
                      colour: OTHER_COLOUR,
                      label: `${others.length} other sound${others.length === 1 ? '' : 's'} (${others.reduce((n, e) => n + e.count, 0)})`,
                  }]
                : []),
        ],
    };
};

const Legend = ({ entries }: { entries: Key['legend'] }) => (
    <ul className="legend">
        {entries.map(({ colour, label }) => (
            <li key={label}>
                <span className="swatch" style={{ background: `rgb(${colour.join(',')})` }} />
                {label}
            </li>
        ))}
    </ul>
);

const describe = (r: Result) =>
    `${r.sound.title ?? `sound ${r.sound.id}`} · ${r.annotation.start_seconds!.toFixed(2)}s · distance ${r.distance.toFixed(3)}`;

/** The query segment's neighbours, projected to 3-d with t-SNE */
export const SimilarSegments = ({ query }: { query: AnnotationResource }) => {
    const [limit, setLimit] = useState(200);
    const [otherSounds, setOtherSounds] = useState(false);
    const [results, setResults] = useState<Result[] | null>(null);
    const [error, setError] = useState<ApiError | Error | null>(null);
    const [progress, setProgress] = useState('');
    const [selected, setSelected] = useState<Result | null>(null);
    const plot = useRef<Scatter3d | null>(null);

    // search
    useEffect(() => {
        let cancelled = false;
        setResults(null);
        setSelected(null);
        setError(null);
        setProgress('searching…');
        api<SimilarAnnotationsResource>(
            `/annotations/${query.id}/similar?limit=${limit}${otherSounds ? '&exclude_same_sound=true' : ''}`
        )
            .then((r) => !cancelled && setResults(r.items))
            .catch((e) => !cancelled && setError(e));
        return () => {
            cancelled = true;
        };
    }, [query.id, limit, otherSounds]);

    // t-SNE, in a worker, streaming positions into the plot as the layout settles
    useEffect(() => {
        const el = plot.current;
        if (!results || !el) return;
        const { colourOf } = colourKey(results, query.id);
        const points: ScatterPoint[] = results.map((r) => ({
            color: colourOf(r),
            label: describe(r),
            size: r.annotation.id === query.id ? 2 : 1,
            group: r.sound.id,
        }));
        el.points = points;
        if (results.length < 2) {
            setProgress('');
            return;
        }
        const worker = new Worker(new URL('./tsne.worker.ts', import.meta.url), { type: 'module' });
        const iterations = 1000;
        setProgress(`t-SNE: 0/${iterations}`);
        worker.onmessage = (e: MessageEvent<{ positions: Float32Array; iteration: number; done: boolean }>) => {
            el.positions = e.data.positions;
            setProgress(e.data.done ? '' : `t-SNE: ${e.data.iteration}/${iterations}`);
        };
        worker.onerror = (e) => setError(new Error(`t-SNE failed: ${e.message}`));
        worker.postMessage({ vectors: results.map((r) => r.annotation.vector!), iterations, every: 10 });
        return () => worker.terminate();
    }, [results, query.id]);

    const play = useCallback((r: Result) => {
        setSelected(r);
        const start = r.annotation.start_seconds ?? 0;
        const duration = Math.min(r.annotation.duration_seconds ?? MAX_PLAY_SECONDS, MAX_PLAY_SECONDS);
        player.play(r.sound.audio_url, start, duration).catch((e) => setError(e));
    }, []);

    useLayoutEffect(() => {
        const el = plot.current;
        if (!el) return;
        const handler = (e: Event) => {
            const r = results?.[(e as CustomEvent<{ index: number }>).detail.index];
            if (r) play(r);
        };
        el.addEventListener('point-selected', handler);
        return () => el.removeEventListener('point-selected', handler);
    }, [results, play]);

    const sounds = results ? new Set(results.map((r) => r.sound.id)).size : 0;
    const key = useMemo(() => (results ? colourKey(results, query.id) : null), [results, query.id]);
    return (
        <section className="panel">
            <h2>Similar segments</h2>
            <div className="row">
                <label className="inline">
                    Neighbours
                    <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                        {[50, 100, 200, 500].map((n) => (
                            <option key={n}>{n}</option>
                        ))}
                    </select>
                </label>
                <label className="inline">
                    <input type="checkbox" checked={otherSounds} onChange={(e) => setOtherSounds(e.target.checked)} />{' '}
                    other sounds only
                </label>
                <span className="muted">
                    {results && `${results.length} segments from ${sounds} sounds`}
                    {progress && ` · ${progress}`}
                </span>
            </div>
            <ErrorMessage error={error} />
            {key && <Legend entries={key.legend} />}
            <scatter-3d ref={plot} />
            <p className="muted">
                {selected ? (
                    <>
                        ▶ <ApiLink href={selected.sound.links.self!}>{selected.sound.title ?? `sound ${selected.sound.id}`}</ApiLink>
                        {` · ${selected.annotation.start_seconds!.toFixed(2)}s – ${(
                            selected.annotation.start_seconds! + selected.annotation.duration_seconds!
                        ).toFixed(2)}s · distance ${selected.distance.toFixed(3)} · `}
                        <button className="link" onClick={() => play(selected)}>
                            play again
                        </button>
                    </>
                ) : (
                    'Drag to orbit, scroll to zoom. Hover a point to highlight its sound; click it to hear its segment.'
                )}
            </p>
        </section>
    );
};
