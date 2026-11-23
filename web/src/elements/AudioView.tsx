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
