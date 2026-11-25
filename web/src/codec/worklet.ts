/**
 * The `cochlea-codec` AudioWorkletProcessor: decodes a document with the
 * WebAssembly decoder, 128 frames at a time, on the audio thread.
 *
 * processorOptions (all bytes, since there may be no TextDecoder here):
 *   wasm        the module's bytes (compiled synchronously here)
 *   document    the document's JSON
 *   path        JSON Pointer of the node to play (empty: everything)
 *   seek        seconds to skip to before playing (whole-document playback)
 *   resources   [{ uri, pieces: [{ offsetSeconds, pcm, sampleRate, totalSeconds }] }]:
 *               the parts of each resource the document needs, decoded on the main thread
 *
 * Messages posted:  { type: 'error', bytes }  and  { type: 'ended' }
 */
import { WasmDecoder } from './wasm';

// AudioWorkletGlobalScope isn't in TypeScript's DOM lib
declare const sampleRate: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
    readonly port: MessagePort;
}

interface Options {
    processorOptions: {
        wasm: ArrayBuffer;
        document: Uint8Array;
        path: Uint8Array;
        seek: number;
        resources: {
            uri: Uint8Array;
            pieces: { offsetSeconds: number; pcm: Float32Array; sampleRate: number; totalSeconds: number | null }[];
        }[];
    };
}

class CodecProcessor extends AudioWorkletProcessor {
    private decoder: WasmDecoder | null = null;
    private done = false;
    private block = new Float32Array(128);

    constructor(options: Options) {
        super();
        const o = options.processorOptions;
        try {
            const decoder = new WasmDecoder(new WebAssembly.Module(o.wasm), sampleRate);
            const check = (r: { ok: boolean; bytes: Uint8Array }) => {
                if (!r.ok) throw r.bytes;
            };
            check(decoder.load(o.document));
            for (const r of o.resources) {
                for (const p of r.pieces) check(decoder.provideSpan(r.uri, p.pcm, p.sampleRate, p.offsetSeconds, p.totalSeconds));
            }
            check(decoder.build(o.path));
            if (o.seek > 0) decoder.seek(o.seek);
            this.decoder = decoder;
        } catch (e) {
            this.done = true;
            const bytes = e instanceof Uint8Array ? e : new Uint8Array(0);
            this.port.postMessage({ type: 'error', bytes, message: e instanceof Uint8Array ? null : String(e) });
        }
    }

    process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        if (this.done || !this.decoder) return false;
        const channels = outputs[0];
        if (!channels?.length) return true;
        const frames = channels[0]!.length;
        if (this.block.length !== frames) this.block = new Float32Array(frames);
        const n = this.decoder.render(this.block);
        for (const channel of channels) channel.set(this.block);
        if (n < frames) {
            this.done = true;
            this.decoder.destroy();
            this.decoder = null;
            this.port.postMessage({ type: 'ended' });
            return false;
        }
        return true;
    }
}

registerProcessor('cochlea-codec', CodecProcessor);
