import { Link } from 'react-router';
import { downloadSprs } from '../score/sprs';
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

/** The score: what's been played, while recording, newest first */
export const ScorePage = () => {
    const { recording, events } = useScore();
    const newestFirst = [...events].reverse();
    return (
        <>
            <h1>Score</h1>
            <p className="muted">
                While recording, everything you play, anywhere in the app, is noted down with the time you clicked
                (to the millisecond), and shown scrolling past along the bottom of the page. The last{' '}
                {MAX_AGE_MS / 60000} minutes are kept (at most {MAX_EVENTS.toLocaleString()} plays), in this browser
                only. Download it as a <code>.sprs</code> document to keep it: the codec plays it back.
            </p>
            <div className="row">
                <button type="button" className={recording ? 'danger' : ''} onClick={() => setRecording(!recording)}>
                    {recording ? '■ Stop recording' : '● Record'}
                </button>
                <button type="button" className="secondary" disabled={!events.length} onClick={() => downloadSprs(events)}>
                    Download .sprs
                </button>
                <button
                    type="button"
                    className="secondary"
                    disabled={!events.length}
                    onClick={() => confirm(`Clear all ${events.length} plays?`) && clearScore()}
                >
                    Clear
                </button>
                <span className="muted">{events.length.toLocaleString()} plays</span>
            </div>
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
                                <tr key={e.id}>
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
