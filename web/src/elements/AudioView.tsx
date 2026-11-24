import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { AudioViewElement } from './web-components';

export interface AudioViewProps {
    id?: string;
    src: string;
    height?: number;
    samples?: number;
    scale?: number;
    view?: 'time-series' | 'spectrogram';
    controls?: boolean;
    color?: string;
    onPlayed?: (e: CustomEvent<{ url: string; startSeconds: number; durationSeconds: number }>) => void;
}

/**
 * Plays exactly [start, start + duration) of a sound in an `<audio-view>`.
 *
 * Works around `<audio-view>` (web-components 0.0.102) ignoring
 * `playAudio`'s duration once it has rendered: it plays to the end of the
 * visible view (`currentEndTimeSeconds`) instead, i.e. usually to the end of
 * the sound. `playAudio` reads that field synchronously, before its first
 * `await`, so clearing it for the call (and restoring it straight after)
 * makes it use our duration, and leaves the element's own click-to-play
 * as it was. Remove this once web-components prefers an explicit duration.
 */
export const playSpan = (
    el: AudioViewElement,
    url: string,
    startSeconds: number,
    durationSeconds: number,
    /** The triggering DOM event's timeStamp: <audio-view> reports it with the play (see score/store.ts) */
    timeStamp = performance.now()
) => {
    const view = el as AudioViewElement & { currentEndTimeSeconds?: number | null };
    const end = view.currentEndTimeSeconds;
    view.currentEndTimeSeconds = null;
    try {
        el.playAudio(url, startSeconds, durationSeconds, timeStamp);
    } finally {
        view.currentEndTimeSeconds = end;
    }
};

/**
 * Wraps `<audio-view>`.
 *
 * React 19 assigns *properties* (not attributes) on custom elements when the
 * element defines a property of that name.  `<audio-view>` declares `src`,
 * `height`, etc. as properties, but only reacts to *attribute* changes, so
 * `<audio-view src={...}>` would silently never load.  This wrapper sets
 * attributes explicitly instead.
 */
export const AudioView = forwardRef<AudioViewElement | null, AudioViewProps>(function AudioView(
    { id, src, height = 200, samples = 4096, scale = 1, view = 'time-series', controls = true, color, onPlayed },
    forwardedRef
) {
    const ref = useRef<AudioViewElement | null>(null);
    useImperativeHandle(forwardedRef, () => ref.current!, []);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const attrs: Record<string, string | null> = {
            src,
            height: String(height),
            samples: String(samples),
            scale: String(scale),
            view,
            controls: controls ? '' : 'false',
            color: color ?? null,
        };
        for (const [name, value] of Object.entries(attrs)) {
            if (value === null) el.removeAttribute(name);
            else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
        }
    }, [src, height, samples, scale, view, controls, color]);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || !onPlayed) return;
        el.addEventListener('audio-view-played', onPlayed);
        return () => el.removeEventListener('audio-view-played', onPlayed);
    }, [onPlayed]);

    // a wrapping div, because <audio-view> measures its parent's width
    return (
        <div style={{ width: '100%' }}>
            <audio-view ref={ref} id={id} />
        </div>
    );
});
