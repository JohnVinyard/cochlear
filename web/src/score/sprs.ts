/**
 * A score as a cochlea codec document (codec/SPEC.md): one sequencer whose
 * events are samplers, each playing the span the user played, at the time
 * they played it, relative to the score's start (its first event, or the start
 * of a selection). Each sound's URL is defined once, in defs, and referenced,
 * so a long session stays small.
 */
import { SPRS_MIME_TYPE } from '@cochlea/shared';
import { saveBlob } from '../codec/wav';
import type { PlayEvent } from './store';

const round = (x: number, digits = 6) => Number(x.toFixed(digits));

/** How long a play lasts in a document: a sampler needs some duration */
const lengthOf = (e: PlayEvent) => Math.max(e.durationSeconds, 0.001);

/** A score's time zero (epoch ms): its first play */
export const scoreOrigin = (events: PlayEvent[]): number =>
    events.reduce((min, e) => Math.min(min, e.at), events[0]?.at ?? 0);

/**
 * What's heard between `start` and `end` (seconds after `origin`): the plays
 * that overlap it, each trimmed to the overlap, so one that began before the
 * span starts part-way through its sound.
 */
export const trimToSpan = (events: PlayEvent[], origin: number, start: number, end: number): PlayEvent[] =>
    events.flatMap((e) => {
        const t0 = (e.at - origin) / 1000;
        const from = Math.max(t0, start);
        const to = Math.min(t0 + lengthOf(e), end);
        if (to <= from) return [];
        return [
            {
                ...e,
                at: origin + from * 1000,
                startSeconds: e.startSeconds + (from - t0),
                durationSeconds: to - from,
            },
        ];
    });

export interface SprsOptions {
    title?: string;
    /** Time zero (epoch ms); default: the first event */
    origin?: number;
}

export const toSprs = (events: PlayEvent[], { title = 'Score', origin }: SprsOptions = {}): object => {
    const sorted = [...events].sort((a, b) => a.at - b.at);
    const first = origin ?? sorted[0]?.at ?? 0;
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
                    duration_seconds: round(lengthOf(e)),
                    meta: { source: e.source, ...(e.soundId !== null ? { sound_id: e.soundId } : {}) },
                },
            })),
        },
    };
};

/** For file names: now, as 2026-11-25T12-03-21 */
export const fileStamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/** Offers the document as a .sprs download */
export const downloadSprs = (events: PlayEvent[], options: SprsOptions = {}) => {
    const stamp = fileStamp();
    const blob = new Blob([JSON.stringify(toSprs(events, options), null, 2)], { type: SPRS_MIME_TYPE });
    saveBlob(blob, `score-${stamp}.sprs`);
};
