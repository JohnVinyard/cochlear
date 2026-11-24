import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Link } from 'react-router';
import type { ScoreStrip, StripEvent } from '../elements/score-strip';
import '../elements/score-strip';
import { setRecording, useScore } from './store';

/**
 * While recording, a strip along the bottom of every page with what's been
 * played in the last 30 seconds scrolling past. Mounted above the routes, so
 * navigating doesn't interrupt it.
 */
export const ScoreBar = () => {
    const { recording, events, uid } = useScore();
    const strip = useRef<ScoreStrip | null>(null);
    const stripEvents = useMemo<StripEvent[]>(
        () =>
            events.map((e) => ({
                at: e.at,
                durationSeconds: e.durationSeconds,
                lane: e.soundId !== null ? String(e.soundId) : e.audioUrl,
                label: `${e.title ?? (e.soundId !== null ? `sound ${e.soundId}` : 'a sound')} · ${e.startSeconds.toFixed(2)}s`,
            })),
        [events]
    );
    const open = recording && uid !== null;

    useLayoutEffect(() => {
        if (strip.current) strip.current.events = stripEvents;
    }, [stripEvents, open]);

    // keep page content clear of the bar
    useEffect(() => {
        document.body.classList.toggle('score-bar-open', open);
        return () => document.body.classList.remove('score-bar-open');
    }, [open]);

    if (!open) return null;
    return (
        <div className="score-bar" role="region" aria-label="Score: what you've played, recording">
            <div className="score-bar-controls">
                <span className="rec" aria-hidden="true">●</span>
                <Link to="/score">Score</Link>
                <span className="muted">{events.length}</span>
                <button type="button" className="link" onClick={() => setRecording(false)}>
                    stop
                </button>
            </div>
            <score-strip ref={strip} />
        </div>
    );
};
