/**
 * Renders a score (or part of one) to a WAV file, offline: the codec decodes
 * it faster than real time, without playing it.
 */
import { CodecRuntime } from '../codec/runtime';
import { encodeWav, peak, saveBlob } from '../codec/wav';
import { fileStamp, type SprsOptions, toSprs } from './sprs';
import type { PlayEvent } from './store';

export const RENDER_SAMPLE_RATE = 44100;

export type RenderProgress = { phase: 'loading'; loaded: number; total: number } | { phase: 'rendering'; fraction: number };

export interface Rendered {
    seconds: number;
    /** If the plays summed past full scale, how much (dB) it was turned down so it doesn't clip */
    attenuatedDb: number | null;
}

export const downloadWav = async (
    events: PlayEvent[],
    options: SprsOptions,
    onProgress: (p: RenderProgress) => void,
    signal?: AbortSignal
): Promise<Rendered> => {
    const doc = await CodecRuntime.shared().open(toSprs(events, options), {
        onProgress: (loaded, total) => onProgress({ phase: 'loading', loaded, total }),
    });
    if (signal?.aborted) throw new DOMException('rendering was cancelled', 'AbortError');
    const samples = await doc.render({
        sampleRate: RENDER_SAMPLE_RATE,
        signal,
        onProgress: (fraction) => onProgress({ phase: 'rendering', fraction }),
    });
    // overlapping plays are summed: rather than clip, turn the whole thing down
    const max = peak(samples);
    let attenuatedDb: number | null = null;
    if (max > 1) {
        const gain = 0.99 / max;
        for (let i = 0; i < samples.length; i++) samples[i]! *= gain;
        attenuatedDb = -20 * Math.log10(gain);
    }
    saveBlob(encodeWav(samples, RENDER_SAMPLE_RATE), `score-${fileStamp()}.wav`);
    return { seconds: samples.length / RENDER_SAMPLE_RATE, attenuatedDb };
};
