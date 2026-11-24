/**
 * Main-thread side of the codec in the browser.
 *
 * `CodecRuntime.open(document)` validates the document with the WebAssembly
 * decoder, fetches and decodes every resource it needs (`fetch` +
 * `decodeAudioData`, so `data:` URIs and any format the browser supports
 * work), and describes where every node plays. `play()` starts an
 * AudioWorkletNode that decodes on the audio thread.
 */
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

interface DecodedAudio {
    pcm: Float32Array;
    sampleRate: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const parse = <T>(r: RawResult): T => {
    const value = JSON.parse(decoder.decode(r.bytes));
    if (!r.ok) throw new CodecFailure(value as CodecError);
    return value as T;
};

const mono = (buffer: AudioBuffer): Float32Array => {
    if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
    const out = new Float32Array(buffer.length);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
        const data = buffer.getChannelData(c);
        for (let i = 0; i < out.length; i++) out[i]! += data[i]! / buffer.numberOfChannels;
    }
    return out;
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
    private audio = new Map<string, Promise<DecodedAudio>>();
    private _context: AudioContext | null = null;

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

    private decodeAudio(uri: string, baseUrl: string): Promise<DecodedAudio> {
        let p = this.audio.get(uri);
        if (!p) {
            p = (async () => {
                const resp = await fetch(new URL(uri, baseUrl));
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const buffer = await this.context.decodeAudioData(await resp.arrayBuffer());
                return { pcm: mono(buffer), sampleRate: buffer.sampleRate };
            })();
            p.catch(() => this.audio.delete(uri));
            this.audio.set(uri, p);
        }
        return p;
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
            const uris = parse<string[]>(wasm.resources());
            let loaded = 0;
            onProgress?.(0, uris.length);
            const resources = await Promise.all(
                uris.map(async (uri) => {
                    try {
                        const audio = await this.decodeAudio(uri, baseUrl);
                        onProgress?.(++loaded, uris.length);
                        return { uri, ...audio };
                    } catch (e) {
                        const shown = uri.length > 64 ? `${uri.slice(0, 48)}…` : uri;
                        throw new CodecFailure({ path: '', message: `couldn't load ${shown}: ${(e as Error).message}` });
                    }
                })
            );
            for (const r of resources) parse(wasm.provide(encoder.encode(r.uri), r.pcm, r.sampleRate));
            const description = parse<Description>(wasm.build(new Uint8Array()));
            return new OpenDocument(this, json, modules, description, resources);
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
                resources: doc.resources.map((r) => ({ uri: encoder.encode(r.uri), pcm: r.pcm, sampleRate: r.sampleRate })),
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

export class OpenDocument {
    private readonly byPath: Map<string, NodeLayout>;

    constructor(
        private readonly runtime: CodecRuntime,
        readonly json: Uint8Array,
        readonly modules: ModuleInfo[],
        readonly description: Description,
        readonly resources: { uri: string; pcm: Float32Array; sampleRate: number }[]
    ) {
        this.byPath = new Map(description.nodes.map((n) => [n.path, n]));
    }

    node(path: string): NodeLayout | undefined {
        return this.byPath.get(path);
    }

    /** Plays one node (a JSON Pointer) in context, or everything from a time */
    play({ path = '', fromSeconds = 0 }: { path?: string; fromSeconds?: number } = {}): Promise<Playback> {
        return this.runtime.play(this, path, fromSeconds);
    }
}
