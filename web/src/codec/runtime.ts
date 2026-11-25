/**
 * Main-thread side of the codec in the browser.
 *
 * `CodecRuntime.open(document)` validates the document with the WebAssembly
 * decoder, loads the parts of every resource it needs (see resources.ts:
 * range requests for WAV files, else `fetch` + `decodeAudioData`, so `data:`
 * URIs and any format the browser supports work), and describes where every
 * node plays. `play()` starts an AudioWorkletNode that decodes on the audio
 * thread.
 */
import { type Piece, ResourceLoader, type ResourceRequest } from './resources';
import workletUrl from './worklet.ts?worker&url';
import { type RawResult, WasmDecoder } from './wasm';

export const DEFAULT_WASM_URL = '/codec/cochlea_codec.wasm';

export interface CodecError {
    path: string;
    message: string;
}

export interface NodeLayout {
    /** Where the node is in the expanded tree (unique; used to play it) */
    path: string;
    /** Where its JSON is in the document: `path`, unless it came from a `$ref` (e.g. `/defs/four-kicks`) */
    source: string;
    /** The `$ref` that stood in for this node, if one did */
    reference: string | null;
    type: string;
    label: string | null;
    start_seconds: number;
    duration_seconds: number;
}

export interface Description {
    sample_rate: number;
    start_seconds: number;
    duration_seconds: number;
    nodes: NodeLayout[];
}

export interface ModuleInfo {
    type: string;
    version: string;
}

export class CodecFailure extends Error {
    constructor(public readonly error: CodecError) {
        super(error.path ? `${error.path}: ${error.message}` : error.message);
    }
}

/** What's been loaded of one resource */
export interface LoadedResource {
    uri: string;
    pieces: Piece[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const parse = <T>(r: RawResult): T => {
    const value = JSON.parse(decoder.decode(r.bytes));
    if (!r.ok) throw new CodecFailure(value as CodecError);
    return value as T;
};

export interface Playback {
    /** The document time being heard, in seconds */
    position(): number;
    stop(): void;
    /** Resolves when playback ends or is stopped; rejects on a decoder error */
    readonly ended: Promise<void>;
}

export class CodecRuntime {
    private static instances = new Map<string, CodecRuntime>();

    /** One runtime (and AudioContext) per wasm URL */
    static shared(wasmUrl = DEFAULT_WASM_URL): CodecRuntime {
        let r = CodecRuntime.instances.get(wasmUrl);
        if (!r) CodecRuntime.instances.set(wasmUrl, (r = new CodecRuntime(wasmUrl)));
        return r;
    }

    private wasm: Promise<{ bytes: ArrayBuffer; module: WebAssembly.Module }> | null = null;
    private worklet: Promise<void> | null = null;
    private _context: AudioContext | null = null;
    readonly loader = new ResourceLoader((bytes) => this.context.decodeAudioData(bytes));

    constructor(private readonly wasmUrl: string) {}

    get context(): AudioContext {
        return (this._context ??= new AudioContext());
    }

    private loadWasm() {
        return (this.wasm ??= (async () => {
            const resp = await fetch(this.wasmUrl);
            if (!resp.ok) {
                throw new Error(
                    `couldn't load the decoder from ${this.wasmUrl} (HTTP ${resp.status}); build it with \`yarn build-codec\``
                );
            }
            const bytes = await resp.arrayBuffer();
            return { bytes, module: await WebAssembly.compile(bytes) };
        })().catch((e) => {
            this.wasm = null;
            throw e;
        }));
    }

    /**
     * Validates a document, loads its resources and lays it out. `baseUrl`
     * resolves relative URIs (default: the page).
     */
    async open(
        document: unknown,
        { baseUrl = location.href, onProgress }: { baseUrl?: string; onProgress?: (loaded: number, total: number) => void } = {}
    ): Promise<OpenDocument> {
        const json = encoder.encode(typeof document === 'string' ? document : JSON.stringify(document));
        const { module } = await this.loadWasm();
        const wasm = new WasmDecoder(module, this.context.sampleRate);
        try {
            const { modules } = parse<{ modules: ModuleInfo[] }>(wasm.load(json));
            const requests = parse<ResourceRequest[]>(wasm.resourceRequests());
            let loaded = 0;
            onProgress?.(0, requests.length);
            const resources: LoadedResource[] = await Promise.all(
                requests.map(async (request) => {
                    try {
                        const pieces = await this.loader.load(request, baseUrl);
                        onProgress?.(++loaded, requests.length);
                        return { uri: request.uri, pieces };
                    } catch (e) {
                        const uri = request.uri;
                        const shown = uri.length > 64 ? `${uri.slice(0, 48)}…` : uri;
                        throw new CodecFailure({ path: '', message: `couldn't load ${shown}: ${(e as Error).message}` });
                    }
                })
            );
            for (const r of resources) {
                const uri = encoder.encode(r.uri);
                for (const p of r.pieces) parse(wasm.provideSpan(uri, p.pcm, p.sampleRate, p.offsetSeconds, p.totalSeconds));
            }
            const description = parse<Description>(wasm.build(new Uint8Array()));
            return new OpenDocument(this, json, modules, description, resources);
        } finally {
            wasm.destroy();
        }
    }

    /** @internal */
    async render(doc: OpenDocument, { sampleRate = 44100, onProgress, signal }: RenderOptions = {}): Promise<Float32Array> {
        const { module } = await this.loadWasm();
        const wasm = new WasmDecoder(module, sampleRate);
        try {
            parse(wasm.load(doc.json));
            for (const r of doc.resources) {
                const uri = encoder.encode(r.uri);
                for (const p of r.pieces) parse(wasm.provideSpan(uri, p.pcm, p.sampleRate, p.offsetSeconds, p.totalSeconds));
            }
            const description = parse<Description>(wasm.build(new Uint8Array()));
            const total = Math.round(description.duration_seconds * sampleRate);
            const out = new Float32Array(total);
            // a second at a time, yielding in between, so the page stays responsive
            const block = new Float32Array(sampleRate);
            let at = 0;
            while (at < total) {
                if (signal?.aborted) throw new DOMException('rendering was cancelled', 'AbortError');
                const n = Math.min(wasm.render(block), total - at);
                out.set(block.subarray(0, n), at);
                at += n;
                if (n < block.length) break;
                onProgress?.(at / total);
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            onProgress?.(1);
            return at < total ? out.slice(0, at) : out;
        } finally {
            wasm.destroy();
        }
    }

    /** @internal */
    async play(doc: OpenDocument, path: string, fromSeconds: number): Promise<Playback> {
        const ctx = this.context;
        const [{ bytes }] = await Promise.all([
            this.loadWasm(),
            (this.worklet ??= ctx.audioWorklet.addModule(workletUrl)),
            ctx.resume(),
        ]);
        const start = path ? (doc.node(path)?.start_seconds ?? 0) : fromSeconds;
        const node = new AudioWorkletNode(ctx, 'cochlea-codec', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: {
                wasm: bytes,
                document: doc.json,
                path: encoder.encode(path),
                seek: path ? 0 : fromSeconds,
                resources: doc.resources.map((r) => ({ uri: encoder.encode(r.uri), pieces: r.pieces })),
            },
        });
        const startedAt = ctx.currentTime;
        let stopped = false;
        let finish: () => void = () => undefined;
        let fail: (e: Error) => void = () => undefined;
        const ended = new Promise<void>((resolve, reject) => {
            finish = resolve;
            fail = reject;
        });
        const stop = () => {
            if (stopped) return;
            stopped = true;
            node.port.close();
            node.disconnect();
            finish();
        };
        node.port.onmessage = ({ data }) => {
            if (data.type === 'ended') stop();
            if (data.type === 'error') {
                const error: CodecError = data.message
                    ? { path: '', message: data.message }
                    : JSON.parse(decoder.decode(data.bytes as Uint8Array));
                stop();
                fail(new CodecFailure(error));
            }
        };
        node.connect(ctx.destination);
        return { position: () => start + (ctx.currentTime - startedAt), stop, ended };
    }
}

export interface RenderOptions {
    /** Default 44100 */
    sampleRate?: number;
    /** 0 to 1 */
    onProgress?: (fraction: number) => void;
    signal?: AbortSignal;
}

export class OpenDocument {
    private readonly byPath: Map<string, NodeLayout>;

    constructor(
        private readonly runtime: CodecRuntime,
        readonly json: Uint8Array,
        readonly modules: ModuleInfo[],
        readonly description: Description,
        readonly resources: LoadedResource[]
    ) {
        this.byPath = new Map(description.nodes.map((n) => [n.path, n]));
    }

    node(path: string): NodeLayout | undefined {
        return this.byPath.get(path);
    }

    /**
     * Renders the whole document, faster than real time and without playing
     * it, as mono samples at `sampleRate` (default 44100)
     */
    render(options: RenderOptions = {}): Promise<Float32Array> {
        return this.runtime.render(this, options);
    }

    /** Plays one node (a JSON Pointer) in context, or everything from a time */
    play({ path = '', fromSeconds = 0 }: { path?: string; fromSeconds?: number } = {}): Promise<Playback> {
        return this.runtime.play(this, path, fromSeconds);
    }
}
