import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { CodecViewer, Selection } from '../elements/codec-viewer';
import '../elements/codec-viewer';
import { downloadWav, type RenderProgress } from '../score/render';
import { downloadSprs, scoreOrigin, type SprsOptions, toSprs, trimToSpan } from '../score/sprs';
import { clearScore, MAX_AGE_MS, MAX_EVENTS, type PlayEvent, setRecording, useScore } from '../score/store';

const clock = (at: number) => {
    const d = new Date(at);
    return `${d.toLocaleTimeString([], { hour12: false })}.${String(Math.floor(at % 1000)).padStart(3, '0')}`;
};

const SOURCES: Record<PlayEvent['source'], string> = {
    waveform: 'waveform',
    annotation: 'annotation',
    feature: 'feature plot',
    similar: 'similar segments',
    other: 'other',
};

/**
 * The score as a codec document, in <codec-viewer>: its timeline, playback,
 * and a time selection to export. It's updated in place as plays come in, so
 * the selection and what's expanded survive.
 */
const ScoreTimeline = ({
    document,
    origin,
    onSelection,
}: {
    document: object;
    /** The document's time zero (epoch ms) */
    origin: number;
    onSelection: (selection: Selection | null) => void;
}) => {
    const ref = useRef<CodecViewer | null>(null);
    const shownOrigin = useRef(origin);
    useLayoutEffect(() => {
        const viewer = ref.current;
        if (!viewer) return;
        // old plays age out of the score, moving its time zero: keep the selection on the same plays
        const shift = (origin - shownOrigin.current) / 1000;
        shownOrigin.current = origin;
        const s = viewer.selection;
        if (shift && s) {
            viewer.selection =
                s.end_seconds - shift > 0
                    ? { start_seconds: Math.max(s.start_seconds - shift, 0), end_seconds: s.end_seconds - shift }
                    : null;
        }
        viewer.update(document);
    }, [document, origin]);
    useEffect(() => {
        const viewer = ref.current;
        if (!viewer) return;
        const changed = (e: Event) => onSelection((e as CustomEvent<{ selection: Selection | null }>).detail.selection);
        viewer.addEventListener('codec-selection-changed', changed);
        return () => viewer.removeEventListener('codec-selection-changed', changed);
    }, [onSelection]);
    // the table below lists the plays; the tree starts collapsed
    return <codec-viewer ref={ref} max-depth="0" />;
};

/** The score: what's been played, while recording, as a timeline and a table (newest first) */
export const ScorePage = () => {
    const { recording, events } = useScore();
    const newestFirst = [...events].reverse();
    const origin = scoreOrigin(events);
    const document = useMemo(() => (events.length ? toSprs(events) : null), [events]);
    const [selection, setSelection] = useState<Selection | null>(null);
    useEffect(() => {
        if (!events.length) setSelection(null);
    }, [events.length]);

    /** Score time (seconds) of a play */
    const timeOf = (e: PlayEvent) => (e.at - origin) / 1000;
    const inSelection = (e: PlayEvent) =>
        !selection ||
        (timeOf(e) < selection.end_seconds && timeOf(e) + Math.max(e.durationSeconds, 0.001) > selection.start_seconds);

    const selected = selection ? events.filter(inSelection).length : events.length;

    /** What's exported: the selection, trimmed to it, or everything */
    const exported = (): [PlayEvent[], SprsOptions] =>
        selection
            ? [
                  trimToSpan(events, origin, selection.start_seconds, selection.end_seconds),
                  { title: 'Score (selection)', origin: origin + selection.start_seconds * 1000 },
              ]
            : [events, {}];

    const download = () => downloadSprs(...exported());

    const [rendering, setRendering] = useState<{ progress: RenderProgress | null; abort: AbortController } | null>(null);
    const [renderStatus, setRenderStatus] = useState<{ text: string; error?: boolean } | null>(null);
    const render = async () => {
        const abort = new AbortController();
        setRendering({ progress: null, abort });
        setRenderStatus(null);
        try {
            const [plays, options] = exported();
            const { seconds, attenuatedDb } = await downloadWav(
                plays,
                options,
                (progress) => setRendering((r) => r && { ...r, progress }),
                abort.signal
            );
            setRenderStatus({
                text:
                    `Rendered ${seconds.toFixed(2)}s` +
                    (attenuatedDb ? ` (turned down ${attenuatedDb.toFixed(1)} dB: overlapping plays would have clipped)` : ''),
            });
        } catch (e) {
            const cancelled = (e as Error).name === 'AbortError';
            setRenderStatus(cancelled ? { text: 'Cancelled' } : { text: `Couldn't render: ${(e as Error).message}`, error: true });
        } finally {
            setRendering(null);
        }
    };
    const progressText = (p: RenderProgress | null) =>
        !p
            ? 'Preparing…'
            : p.phase === 'loading'
              ? `Loading audio ${p.loaded} of ${p.total}…`
              : `Rendering ${Math.round(p.fraction * 100)}%…`;
    return (
        <>
            <h1>Score</h1>
            <p className="muted">
                While recording, everything you play, anywhere in the app, is noted down with the time you clicked
                (to the millisecond), and shown scrolling past along the bottom of the page. The last{' '}
                {MAX_AGE_MS / 60000} minutes are kept (at most {MAX_EVENTS.toLocaleString()} plays), in this browser
                only. Download it as a <code>.sprs</code> document to keep it (the codec plays it back), or render
                it to a <code>.wav</code> file. Drag across the timeline to export just part of it.
            </p>
            <div className="row">
                <button type="button" className={recording ? 'danger' : ''} onClick={() => setRecording(!recording)}>
                    {recording ? '■ Stop recording' : '● Record'}
                </button>
                <button
                    type="button"
                    className="secondary"
                    disabled={!selected}
                    title={selection && !selected ? 'Nothing was played in the selection' : undefined}
                    onClick={download}
                >
                    {selection ? 'Download selection (.sprs)' : 'Download .sprs'}
                </button>
                {rendering ? (
                    <button type="button" className="secondary" onClick={() => rendering.abort.abort()}>
                        Cancel ({progressText(rendering.progress)})
                    </button>
                ) : (
                    <button
                        type="button"
                        className="secondary"
                        disabled={!selected}
                        title="Render it to audio, offline (faster than playing it), as a 44.1 kHz WAV file"
                        onClick={render}
                    >
                        {selection ? 'Render selection (.wav)' : 'Render .wav'}
                    </button>
                )}
                <button
                    type="button"
                    className="secondary"
                    disabled={!events.length}
                    onClick={() => confirm(`Clear all ${events.length} plays?`) && clearScore()}
                >
                    Clear
                </button>
                <span className="muted">
                    {selection
                        ? `${selected.toLocaleString()} of ${events.length.toLocaleString()} plays selected`
                        : `${events.length.toLocaleString()} plays`}
                </span>
            </div>
            {renderStatus && <p className={renderStatus.error ? 'error' : 'muted'}>{renderStatus.text}</p>}
            {document && <ScoreTimeline document={document} origin={origin} onSelection={setSelection} />}
            {events.length ? (
                <table>
                    <thead>
                        <tr>
                            <th>time</th>
                            <th className="number" title="Since the play before">gap</th>
                            <th>sound</th>
                            <th>segment</th>
                            <th>from</th>
                        </tr>
                    </thead>
                    <tbody>
                        {newestFirst.map((e, i) => {
                            const previous = newestFirst[i + 1];
                            return (
                                <tr key={e.id} className={inSelection(e) ? undefined : 'outside-selection'}>
                                    <td className="number">{clock(e.at)}</td>
                                    <td className="number">{previous ? `${((e.at - previous.at) / 1000).toFixed(3)}s` : ''}</td>
                                    <td className="sound">
                                        {e.soundId !== null ? (
                                            <Link to={`/sounds/${e.soundId}`}>{e.title ?? `sound ${e.soundId}`}</Link>
                                        ) : (
                                            <a href={e.audioUrl}>{e.title ?? e.audioUrl}</a>
                                        )}
                                    </td>
                                    <td>
                                        {e.startSeconds.toFixed(2)}s – {(e.startSeconds + e.durationSeconds).toFixed(2)}s
                                    </td>
                                    <td className="muted">{SOURCES[e.source]}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            ) : (
                <p className="muted">{recording ? 'Recording: play something.' : 'Nothing recorded yet.'}</p>
            )}
        </>
    );
};
