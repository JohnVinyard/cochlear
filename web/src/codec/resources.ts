/**
 * Loads the parts of resources a codec document needs: the decoder says
 * which spans of each URI its nodes read (`cc_resource_requests`), and this
 * fetches just those, where it can.
 *
 * WAV files are read like the 3-d plot's segments (audio/segments.ts): the
 * header (the first 64 KB) once, then only the bytes of each span, with HTTP
 * Range requests, decoded here. Anything else (compressed formats, `data:`
 * URIs, servers or CORS policies that don't allow ranges) is fetched whole,
 * once, and decoded by the browser.
 *
 * Spans close together (within MERGE_GAP_SECONDS) are fetched as one, and
 * every piece is kept, so a document that's updated (a score as it's
 * recorded) or played again doesn't fetch it twice.
 */
import { decodePcm, parseWavHeader, segmentRange, type WavFormat } from '../audio/segments';

export interface Span {
    start_seconds: number;
    /** null: to the end */
    end_seconds: number | null;
}

export interface ResourceRequest {
    uri: string;
    spans: Span[];
}

/** Mono audio for part (or all) of a resource */
export interface Piece {
    /** Where it starts in the resource */
    offsetSeconds: number;
    pcm: Float32Array;
    sampleRate: number;
    /** The whole resource's length, if known */
    totalSeconds: number | null;
}

const HEADER_BYTES = 64 * 1024;
/** Spans closer than this are fetched in one request */
export const MERGE_GAP_SECONDS = 2;

type Source =
    | { kind: 'wav'; url: string; format: WavFormat; totalSeconds: number }
    | { kind: 'whole'; url: string };

const pieceEnd = (p: Piece) => p.offsetSeconds + p.pcm.length / p.sampleRate;

const covers = (p: Piece, span: Span) => {
    // within a frame: spans are converted to frames by the decoder
    const slop = 1 / p.sampleRate;
    const end = span.end_seconds ?? p.totalSeconds;
    if (end === null) return false;
    const clampedEnd = p.totalSeconds === null ? end : Math.min(end, p.totalSeconds);
    const start = p.totalSeconds === null ? span.start_seconds : Math.min(span.start_seconds, p.totalSeconds);
    return p.offsetSeconds <= start + slop && clampedEnd <= pieceEnd(p) + slop;
};

/** Merges spans that overlap, or are within `gap` seconds of each other */
export const mergeSpans = (spans: Span[], gap = MERGE_GAP_SECONDS): Span[] => {
    const out: Span[] = [];
    for (const s of [...spans].sort((a, b) => a.start_seconds - b.start_seconds)) {
        const last = out[out.length - 1];
        if (last && (last.end_seconds === null || s.start_seconds <= last.end_seconds + gap)) {
            last.end_seconds = last.end_seconds === null || s.end_seconds === null ? null : Math.max(last.end_seconds, s.end_seconds);
        } else {
            out.push({ ...s });
        }
    }
    return out;
};

const mono = (channels: Float32Array[]): Float32Array => {
    if (channels.length === 1) return channels[0]!;
    const out = new Float32Array(channels[0]!.length);
    for (const c of channels) for (let i = 0; i < out.length; i++) out[i]! += c[i]! / channels.length;
    return out;
};

/** `bytes a-b/1234` -> 1234 (only readable if the server exposes Content-Range) */
const fileSize = (res: Response): number | null => {
    const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '');
    return m ? Number(m[1]) : null;
};

/** `bytes=from-to` (`to` null: to the end); null if the server sent the whole file instead */
const fetchRange = async (url: string, from: number, to: number | null): Promise<Response | null> => {
    const res = await fetch(url, { headers: { Range: `bytes=${from}-${to ?? ''}` } });
    if (res.status === 206) return res;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.body?.cancel();
    return null;
};

export class ResourceLoader {
    private sources = new Map<string, Promise<Source>>();
    private pieces = new Map<string, Piece[]>();
    private pending = new Map<string, Promise<Piece>>();

    constructor(private readonly decodeWhole: (bytes: ArrayBuffer) => Promise<AudioBuffer>) {}

    /** How much has been fetched, for the curious (and tests) */
    cached(uri: string): readonly Piece[] {
        return this.pieces.get(uri) ?? [];
    }

    /** Pieces that together cover every span of the request */
    async load(request: ResourceRequest, baseUrl: string): Promise<Piece[]> {
        const url = new URL(request.uri, baseUrl).href;
        const have = () => this.pieces.get(request.uri) ?? [];
        const needed = request.spans.filter((s) => !have().some((p) => covers(p, s)));
        if (needed.length) {
            const source = await this.source(url);
            if (source.kind === 'whole') {
                await this.once(`${request.uri}#whole`, request.uri, () => this.fetchWhole(url));
            } else {
                await Promise.all(
                    mergeSpans(needed).map((span) =>
                        this.once(`${request.uri}#${span.start_seconds}-${span.end_seconds}`, request.uri, () =>
                            this.fetchSpan(source, span)
                        )
                    )
                );
            }
        }
        // the smallest set that covers what was asked for
        const used = new Set<Piece>();
        for (const span of request.spans) {
            const piece = have().find((p) => covers(p, span));
            if (piece) used.add(piece);
        }
        return [...used];
    }

    /** Fetches a piece once, however many documents ask for it at the same time */
    private async once(key: string, uri: string, fetchPiece: () => Promise<Piece>): Promise<void> {
        let p = this.pending.get(key);
        if (!p) {
            p = fetchPiece().then((piece) => {
                const list = this.pieces.get(uri) ?? [];
                // a whole resource makes every part of it redundant
                this.pieces.set(uri, piece.offsetSeconds === 0 && pieceEnd(piece) >= (piece.totalSeconds ?? Infinity) ? [piece] : [...list, piece]);
                return piece;
            });
            p.finally(() => this.pending.delete(key)).catch(() => undefined);
            this.pending.set(key, p);
        }
        await p;
    }

    private source(url: string): Promise<Source> {
        let s = this.sources.get(url);
        if (!s) {
            s = (async (): Promise<Source> => {
                if (url.startsWith('data:')) return { kind: 'whole', url };
                try {
                    const res = await fetchRange(url, 0, HEADER_BYTES - 1);
                    if (!res) return { kind: 'whole', url };
                    const size = fileSize(res);
                    const format = parseWavHeader(await res.arrayBuffer());
                    if (!format) return { kind: 'whole', url };
                    // streamed WAVs may say 0 (or 0xFFFFFFFF) bytes of data: trust the file size
                    let dataBytes = format.dataBytes;
                    if (size !== null && (dataBytes === 0 || format.dataOffset + dataBytes > size)) {
                        dataBytes = size - format.dataOffset;
                    }
                    const fixed = { ...format, dataBytes };
                    return { kind: 'wav', url, format: fixed, totalSeconds: dataBytes / format.blockAlign / format.sampleRate };
                } catch {
                    return { kind: 'whole', url }; // e.g. a CORS policy that rejects Range
                }
            })();
            this.sources.set(url, s);
        }
        return s;
    }

    private async fetchSpan(source: Extract<Source, { kind: 'wav' }>, span: Span): Promise<Piece> {
        const { format, totalSeconds } = source;
        const end = Math.min(span.end_seconds ?? totalSeconds, totalSeconds);
        const range = segmentRange(format, span.start_seconds, end - span.start_seconds);
        const empty = { offsetSeconds: Math.min(span.start_seconds, totalSeconds), pcm: new Float32Array(0), sampleRate: format.sampleRate, totalSeconds };
        // the span is past the end: the decoder reports it, knowing the length
        if (!range) return empty;
        const res = await fetchRange(source.url, range[0], range[1]);
        if (!res) {
            // the server ignores ranges after all
            this.sources.set(source.url, Promise.resolve({ kind: 'whole', url: source.url }));
            return this.fetchWhole(source.url);
        }
        const pcm = mono(decodePcm(await res.arrayBuffer(), format));
        const firstFrame = (range[0] - format.dataOffset) / format.blockAlign;
        return { offsetSeconds: firstFrame / format.sampleRate, pcm, sampleRate: format.sampleRate, totalSeconds };
    }

    private async fetchWhole(url: string): Promise<Piece> {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = await this.decodeWhole(await res.arrayBuffer());
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
        return { offsetSeconds: 0, pcm: mono(channels).slice(), sampleRate: buffer.sampleRate, totalSeconds: buffer.duration };
    }
}
