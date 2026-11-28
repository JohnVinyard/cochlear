/**
 * Plays a sound, or a segment of one, from anywhere a list of them is shown
 * (e.g. favorites). One thing plays at a time: starting something stops
 * whatever was playing, or was about to.
 *
 * - a segment: SegmentPlayer, which fetches just its bytes where it can
 * - a whole sound: an <audio> element, which streams it (a whole MusicNet
 *   recording is ~100 MB, too much to fetch before playing)
 * - a codec document (codec/sounds.ts): the codec runtime, from the start of
 *   the segment, stopped at its end
 */
import type { SoundResource } from '@cochlea/shared';
import { CodecRuntime, type OpenDocument } from '../codec/runtime';
import { codecDocumentUrl } from '../codec/sounds';
import { SegmentPlayer, type Playing } from './segments';

export type { Playing };

export interface Span {
    start_seconds: number;
    duration_seconds: number;
}

const segments = new SegmentPlayer();
let current: Playing | null = null;
let generation = 0;

const documents = new Map<string, Promise<OpenDocument>>();

const openDocument = (url: string): Promise<OpenDocument> => {
    let doc = documents.get(url);
    if (!doc) {
        doc = (async () => {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
            return CodecRuntime.shared().open(await res.text(), { baseUrl: url });
        })();
        doc.catch(() => documents.delete(url));
        documents.set(url, doc);
    }
    return doc;
};

const playDocument = async (url: string, start: number, duration: number): Promise<Playing> => {
    const doc = await openDocument(url);
    const playback = await doc.play({ fromSeconds: start });
    const timer = setTimeout(() => playback.stop(), duration * 1000);
    const ended = playback.ended.catch(() => undefined).finally(() => clearTimeout(timer));
    return { stop: () => playback.stop(), ended };
};

const playWhole = async (url: string): Promise<Playing> => {
    const audio = new Audio(url);
    let finish!: () => void;
    const ended = new Promise<void>((resolve) => (finish = resolve));
    const stop = () => {
        audio.pause();
        audio.removeAttribute('src'); // stop downloading
        audio.load();
        finish();
    };
    audio.addEventListener('ended', finish);
    audio.addEventListener('error', finish);
    await audio.play();
    return { stop, ended };
};

/** Plays the sound, or `span` of it. Resolves when it's started, with how to stop it. */
export const playSound = async (sound: SoundResource, span: Span | null): Promise<Playing> => {
    stopPlaying();
    const mine = ++generation;
    const start = span?.start_seconds ?? 0;
    const duration = span?.duration_seconds ?? sound.duration_seconds;
    const codec = codecDocumentUrl(sound);
    const playing = codec
        ? await playDocument(codec, start, duration)
        : span
          ? await segments.play(sound.audio_url, start, duration)
          : await playWhole(sound.audio_url);
    if (mine !== generation) {
        // something else was played (or this was stopped) while this one was loading
        playing.stop();
        return { stop: () => undefined, ended: Promise.resolve() };
    }
    current = playing;
    void playing.ended.then(() => {
        if (current === playing) current = null;
    });
    return playing;
};

export const stopPlaying = () => {
    generation++;
    current?.stop();
    current = null;
    segments.stop();
};
