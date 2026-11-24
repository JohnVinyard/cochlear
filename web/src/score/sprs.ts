/**
 * A score as a cochlea codec document (codec/SPEC.md): one sequencer whose
 * events are samplers, each playing the span the user played, at the time
 * they played it, relative to the first event. Each sound's URL is defined
 * once, in defs, and referenced, so a long session stays small.
 */
import { SPRS_MIME_TYPE } from '@cochlea/shared';
import type { PlayEvent } from './store';

const round = (x: number, digits = 6) => Number(x.toFixed(digits));

export const toSprs = (events: PlayEvent[], title = 'Score'): object => {
    const sorted = [...events].sort((a, b) => a.at - b.at);
    const first = sorted[0]?.at ?? 0;
    const defs: Record<string, string> = {};
    const names = new Map<string, string>();
    const nameFor = (e: PlayEvent) => {
        let name = names.get(e.audioUrl);
        if (!name) {
            name = e.soundId !== null ? `sound-${e.soundId}` : `audio-${names.size + 1}`;
            names.set(e.audioUrl, name);
            defs[name] = e.audioUrl;
        }
        return name;
    };
    return {
        format: 'cochlea-codec',
        version: '0.2',
        meta: {
            title,
            recorded_at: new Date(first).toISOString(),
            events: sorted.length,
            created_with: 'the cochlea web app (Score)',
        },
        defs,
        root: {
            type: 'sequencer',
            label: title,
            events: sorted.map((e) => ({
                time_seconds: round((e.at - first) / 1000),
                node: {
                    type: 'sampler',
                    ...(e.title ? { label: e.title } : {}),
                    url: { $ref: `#/defs/${nameFor(e)}` },
                    start_seconds: round(e.startSeconds),
                    duration_seconds: round(Math.max(e.durationSeconds, 0.001)),
                    meta: { source: e.source, ...(e.soundId !== null ? { sound_id: e.soundId } : {}) },
                },
            })),
        },
    };
};

/** Offers the document as a .sprs download */
export const downloadSprs = (events: PlayEvent[], title = 'Score') => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const blob = new Blob([JSON.stringify(toSprs(events, title), null, 2)], { type: SPRS_MIME_TYPE });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: `score-${stamp}.sprs` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};
