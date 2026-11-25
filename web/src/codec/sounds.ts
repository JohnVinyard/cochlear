/**
 * Sounds whose audio is a cochlea codec document: `audio_url` is a `.sprs`
 * file, described by a format at the same URL with the codec's media type
 * (docs/sound-formats.md). There may be no other audio for them, so the web
 * app shows the document in <codec-viewer>, and renders it when it needs
 * audio (a waveform, a spectrogram).
 */
import { SPRS_MIME_TYPE, type SoundResource } from '@cochlea/shared';
import { useEffect, useState } from 'react';
import { CodecRuntime } from './runtime';
import { encodeWav } from './wav';

/** The sound's codec document's URL, if its audio is one */
export const codecDocumentUrl = (sound: Pick<SoundResource, 'audio_url' | 'formats'>): string | null =>
    sound.formats.some((f) => f.mime_type === SPRS_MIME_TYPE && f.url === sound.audio_url) ? sound.audio_url : null;

export interface CodecDocument {
    document: Record<string, unknown>;
    durationSeconds: number;
}

/** The codec document at `url`, laid out (so its duration is known), or null if it isn't one */
export const probeCodecDocument = async (url: string): Promise<CodecDocument | null> => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    const type = res.headers.get('content-type') ?? '';
    if (/^audio\/(?!vnd\.cochlea)/.test(type)) {
        await res.body?.cancel();
        return null;
    }
    let document: unknown;
    try {
        document = JSON.parse(await res.text());
    } catch {
        return null;
    }
    if ((document as { format?: unknown } | null)?.format !== 'cochlea-codec') return null;
    const open = await CodecRuntime.shared().open(document, { baseUrl: url });
    return { document: document as Record<string, unknown>, durationSeconds: open.description.duration_seconds };
};

export const RENDER_SAMPLE_RATE = 44100;

/**
 * The document at `url` rendered to a WAV (as a `blob:` URL), once `enabled`;
 * revoked when it's no longer needed.
 */
export const useRenderedAudio = (url: string | null, enabled: boolean) => {
    const [rendered, setRendered] = useState<{ url: string; source: string } | null>(null);
    const [error, setError] = useState<Error | null>(null);
    useEffect(() => {
        if (!url || !enabled || rendered?.source === url) return;
        let cancelled = false;
        setError(null);
        (async () => {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
            const open = await CodecRuntime.shared().open(await res.text(), { baseUrl: url });
            const samples = await open.render({ sampleRate: RENDER_SAMPLE_RATE });
            if (!cancelled) setRendered({ url: URL.createObjectURL(encodeWav(samples, RENDER_SAMPLE_RATE)), source: url });
        })().catch((e) => !cancelled && setError(e as Error));
        return () => {
            cancelled = true;
        };
    }, [url, enabled, rendered?.source]);
    // a blob holds the whole render: let it go with the page
    useEffect(
        () => () => {
            if (rendered) URL.revokeObjectURL(rendered.url);
        },
        [rendered]
    );
    return { url: rendered?.source === url ? rendered.url : null, error };
};
