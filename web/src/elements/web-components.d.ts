/**
 * JSX typings for custom elements.  `<audio-view>` comes from
 * https://github.com/JohnVinyard/web-components (loaded via <script> in
 * index.html), which ships no type declarations.
 */
import type { DetailedHTMLProps, HTMLAttributes } from 'react';

type CustomElementProps<T> = DetailedHTMLProps<HTMLAttributes<T>, T> & Record<string, unknown>;

export interface AudioViewElement extends HTMLElement {
    playAudio(url: string, startSeconds: number, durationSeconds?: number, timestamp?: number): void;
}

declare module 'react' {
    namespace JSX {
        interface IntrinsicElements {
            'audio-view': CustomElementProps<AudioViewElement>;
            'annotation-timeline': CustomElementProps<HTMLElement>;
        }
    }
}

declare global {
    interface HTMLElementEventMap {
        'audio-view-loaded': CustomEvent<{ url: string }>;
        'audio-view-played': CustomEvent<{
            url: string;
            startSeconds: number;
            durationSeconds: number;
            eventTime: number;
        }>;
        'annotation-selected': CustomEvent<{ id: number; startSeconds: number; durationSeconds: number }>;
    }
}
