/**
 * Plays a segment of a remote sound without downloading all of it, where
 * possible.
 *
 * For WAV files it fetches the header (the first 64 KB) once, then just the
 * bytes of the segment, with an HTTP Range request, and decodes the PCM
 * itself. Anything else (compressed formats, servers or CORS policies that
 * don't allow ranges) falls back to fetching and decoding the whole file,
 * once, through decodeAudioData.
 *
 * Range requests across origins: a single `Range: bytes=a-b` is a
 * CORS-safelisted header in current browsers, so it needs no preflight.
 * Where a browser does preflight it, the server's CORS rules must allow the
 * Range header (e.g. S3: "AllowedHeaders": ["Range"]).
 */

export interface WavFormat {
    /** 1: integer PCM, 3: IEEE float */
    format: 1 | 3;
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
    blockAlign: number;
    /** Byte offset of the first sample, and the number of bytes of samples */
    dataOffset: number;
    dataBytes: number;
}

const HEADER_BYTES = 64 * 1024;

const fourcc = (v: DataView, at: number) =>
    String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));

/** Parses a RIFF/WAVE header from the start of a file, or null if it isn't one we can slice */
export function parseWavHeader(bytes: ArrayBuffer): WavFormat | null {
    const v = new DataView(bytes);
    if (bytes.byteLength < 12 || fourcc(v, 0) !== 'RIFF' || fourcc(v, 8) !== 'WAVE') return null;
    let fmt: Omit<WavFormat, 'dataOffset' | 'dataBytes'> | null = null;
    for (let at = 12; at + 8 <= bytes.byteLength; ) {
        const id = fourcc(v, at);
        const size = v.getUint32(at + 4, true);
        if (id === 'fmt ') {
            let format = v.getUint16(at + 8, true);
            if (format === 0xfffe && size >= 40) format = v.getUint16(at + 32, true); // WAVE_FORMAT_EXTENSIBLE
            const bitsPerSample = v.getUint16(at + 22, true);
            if (format !== 1 && format !== 3) return null;
            fmt = {
                format,
                channels: v.getUint16(at + 10, true),
                sampleRate: v.getUint32(at + 12, true),
                blockAlign: v.getUint16(at + 20, true),
                bitsPerSample,
            };
        } else if (id === 'data') {
            if (!fmt) return null;
            return { ...fmt, dataOffset: at + 8, dataBytes: size };
        }
        at += 8 + size + (size % 2); // chunks are word-aligned
    }
    return null; // no data chunk in the first 64 KB
}

/** Interleaved PCM to one Float32Array per channel */
export function decodePcm(bytes: ArrayBuffer, f: WavFormat): Float32Array[] {
    const v = new DataView(bytes);
    const bytesPer = f.bitsPerSample / 8;
    const frames = Math.floor(bytes.byteLength / f.blockAlign);
    const read: (at: number) => number =
        f.format === 3
            ? f.bitsPerSample === 64
                ? (at) => v.getFloat64(at, true)
                : (at) => v.getFloat32(at, true)
            : f.bitsPerSample === 8
              ? (at) => (v.getUint8(at) - 128) / 128
              : f.bitsPerSample === 16
                ? (at) => v.getInt16(at, true) / 32768
                : f.bitsPerSample === 24
                  ? (at) => ((v.getUint8(at) | (v.getUint8(at + 1) << 8) | (v.getInt8(at + 2) << 16)) / 8388608)
                  : (at) => v.getInt32(at, true) / 2147483648;
    return Array.from({ length: f.channels }, (_, c) => {
        const out = new Float32Array(frames);
        for (let i = 0; i < frames; i++) out[i] = read(i * f.blockAlign + c * bytesPer);
        return out;
    });
}

/** Byte range (inclusive) of a segment's samples */
export function segmentRange(f: WavFormat, startSeconds: number, durationSeconds: number): [number, number] | null {
    const frames = Math.floor(f.dataBytes / f.blockAlign);
    const first = Math.max(0, Math.floor(startSeconds * f.sampleRate));
    const last = Math.min(frames, Math.ceil((startSeconds + durationSeconds) * f.sampleRate));
    if (last <= first) return null;
    return [f.dataOffset + first * f.blockAlign, f.dataOffset + last * f.blockAlign - 1];
}

/**
 * Fetches `bytes=from-to`. Returns null if the server answered with the
 * whole file instead (200), having read no more of it than necessary.
 */
async function fetchRange(url: string, from: number, to: number, signal?: AbortSignal): Promise<ArrayBuffer | null> {
    const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}` }, signal });
    if (res.status === 206) return res.arrayBuffer();
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    await res.body?.cancel();
    return null;
}

type Source = { kind: 'wav'; format: WavFormat } | { kind: 'whole' };

export class SegmentPlayer {
    private readonly sources = new Map<string, Promise<Source>>();
    private readonly decoded = new Map<string, Promise<AudioBuffer>>();
    private context: AudioContext | null = null;
    private playing: { node: AudioBufferSourceNode; gain: GainNode } | null = null;
    private request: AbortController | null = null;

    /** For tests and the curious: how each URL is being read */
    async sourceKind(url: string): Promise<Source['kind']> {
        return (await this.source(url)).kind;
    }

    private source(url: string): Promise<Source> {
        let s = this.sources.get(url);
        if (!s) {
            s = (async (): Promise<Source> => {
                try {
                    const head = await fetchRange(url, 0, HEADER_BYTES - 1);
                    const format = head && parseWavHeader(head);
                    return format ? { kind: 'wav', format } : { kind: 'whole' };
                } catch {
                    return { kind: 'whole' }; // e.g. a CORS policy that rejects Range
                }
            })();
            this.sources.set(url, s);
        }
        return s;
    }

    private audioContext(): AudioContext {
        this.context ??= new AudioContext();
        if (this.context.state === 'suspended') void this.context.resume();
        return this.context;
    }

    /** The samples of [start, start + duration), as an AudioBuffer */
    async segment(url: string, startSeconds: number, durationSeconds: number, signal?: AbortSignal): Promise<AudioBuffer> {
        const ctx = this.audioContext();
        const source = await this.source(url);
        if (source.kind === 'wav') {
            const range = segmentRange(source.format, startSeconds, durationSeconds);
            if (!range) throw new Error('the segment is outside the sound');
            const bytes = await fetchRange(url, range[0], range[1], signal);
            if (bytes) {
                const channels = decodePcm(bytes, source.format);
                const buffer = ctx.createBuffer(channels.length, channels[0]!.length, source.format.sampleRate);
                channels.forEach((c, i) => buffer.copyToChannel(c as Float32Array<ArrayBuffer>, i));
                return buffer;
            }
            this.sources.set(url, Promise.resolve({ kind: 'whole' })); // the server ignores ranges after all
        }
        let whole = this.decoded.get(url);
        if (!whole) {
            whole = fetch(url, { signal })
                .then((r) => {
                    if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
                    return r.arrayBuffer();
                })
                .then((b) => ctx.decodeAudioData(b));
            whole.catch(() => this.decoded.delete(url));
            this.decoded.set(url, whole);
            // keep a few whole sounds decoded, not all of them
            if (this.decoded.size > 4) this.decoded.delete(this.decoded.keys().next().value!);
        }
        const all = await whole;
        const first = Math.floor(startSeconds * all.sampleRate);
        const frames = Math.max(1, Math.min(all.length - first, Math.ceil(durationSeconds * all.sampleRate)));
        const buffer = ctx.createBuffer(all.numberOfChannels, frames, all.sampleRate);
        for (let c = 0; c < all.numberOfChannels; c++) {
            buffer.copyToChannel(all.getChannelData(c).subarray(first, first + frames), c);
        }
        return buffer;
    }

    /** Plays a segment, stopping whatever was playing. Resolves when it's started. */
    async play(url: string, startSeconds: number, durationSeconds: number): Promise<void> {
        this.stop();
        const request = (this.request = new AbortController());
        const buffer = await this.segment(url, startSeconds, durationSeconds, request.signal);
        if (request.signal.aborted) return;
        const ctx = this.audioContext();
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        // short fades, so segments cut out of the middle of a sound don't click
        const gain = ctx.createGain();
        const fade = Math.min(0.01, buffer.duration / 4);
        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(1, ctx.currentTime + fade);
        gain.gain.setValueAtTime(1, ctx.currentTime + buffer.duration - fade);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + buffer.duration);
        node.connect(gain).connect(ctx.destination);
        node.start();
        this.playing = { node, gain };
        node.onended = () => {
            if (this.playing?.node === node) this.playing = null;
        };
    }

    stop(): void {
        this.request?.abort();
        this.request = null;
        if (this.playing) {
            try {
                this.playing.node.stop();
            } catch {
                /* not started */
            }
            this.playing = null;
        }
    }
}
