/**
 * A thin wrapper over the codec's WebAssembly C ABI
 * (`codec/rust/crates/wasm/src/lib.rs`).
 *
 * It deals only in bytes, never strings, because it also runs inside an
 * AudioWorkletGlobalScope, where `TextEncoder`/`TextDecoder` may not exist.
 * The main thread wraps it in `CodecDecoder` (runtime.ts).
 */

interface Exports {
    memory: WebAssembly.Memory;
    cc_alloc(len: number): number;
    cc_free(ptr: number, len: number): void;
    cc_new(sampleRate: number): number;
    cc_destroy(h: number): void;
    cc_result_ptr(h: number): number;
    cc_result_len(h: number): number;
    cc_load(h: number, ptr: number, len: number): number;
    cc_resources(h: number): number;
    cc_provide(h: number, uriPtr: number, uriLen: number, pcmPtr: number, frames: number, sampleRate: number): number;
    cc_build(h: number, pathPtr: number, pathLen: number): number;
    cc_seek(h: number, seconds: number): void;
    cc_render(h: number, outPtr: number, frames: number): number;
}

/** `ok: false` results are JSON `{ path, message }` */
export interface RawResult {
    ok: boolean;
    bytes: Uint8Array;
}

export class WasmDecoder {
    private readonly x: Exports;
    private readonly h: number;
    private outPtr = 0;
    private outFrames = 0;

    /** Synchronous, so it works in an AudioWorkletProcessor's constructor */
    constructor(module: WebAssembly.Module, sampleRate: number) {
        this.x = new WebAssembly.Instance(module, {}).exports as unknown as Exports;
        this.h = this.x.cc_new(sampleRate);
    }

    private withBytes<T>(bytes: Uint8Array, f: (ptr: number, len: number) => T): T {
        const ptr = this.x.cc_alloc(bytes.length);
        new Uint8Array(this.x.memory.buffer, ptr, bytes.length).set(bytes);
        try {
            return f(ptr, bytes.length);
        } finally {
            this.x.cc_free(ptr, bytes.length);
        }
    }

    private result(status: number): RawResult {
        const ptr = this.x.cc_result_ptr(this.h);
        const len = this.x.cc_result_len(this.h);
        return { ok: status === 0, bytes: new Uint8Array(this.x.memory.buffer, ptr, len).slice() };
    }

    load(json: Uint8Array): RawResult {
        return this.result(this.withBytes(json, (p, n) => this.x.cc_load(this.h, p, n)));
    }

    resources(): RawResult {
        return this.result(this.x.cc_resources(this.h));
    }

    provide(uri: Uint8Array, pcm: Float32Array, sampleRate: number): RawResult {
        const status = this.withBytes(uri, (up, un) => {
            const bytes = pcm.length * 4;
            const pp = this.x.cc_alloc(bytes);
            new Float32Array(this.x.memory.buffer, pp, pcm.length).set(pcm);
            try {
                return this.x.cc_provide(this.h, up, un, pp, pcm.length, sampleRate);
            } finally {
                this.x.cc_free(pp, bytes);
            }
        });
        return this.result(status);
    }

    /** `path` empty: the whole document; otherwise a JSON Pointer to one node */
    build(path: Uint8Array): RawResult {
        return this.result(this.withBytes(path, (p, n) => this.x.cc_build(this.h, p, n)));
    }

    seek(seconds: number): void {
        this.x.cc_seek(this.h, seconds);
    }

    /** Fills `out`; returns how many frames were real audio (fewer at the end) */
    render(out: Float32Array): number {
        if (out.length > this.outFrames) {
            if (this.outPtr) this.x.cc_free(this.outPtr, this.outFrames * 4);
            this.outPtr = this.x.cc_alloc(out.length * 4);
            this.outFrames = out.length;
        }
        const n = this.x.cc_render(this.h, this.outPtr, out.length);
        // the view must be made after the call: memory may have grown
        out.set(new Float32Array(this.x.memory.buffer, this.outPtr, out.length));
        return n;
    }

    destroy(): void {
        if (this.outPtr) this.x.cc_free(this.outPtr, this.outFrames * 4);
        this.x.cc_destroy(this.h);
    }
}
