import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CodecViewer } from '../elements/codec-viewer';
import '../elements/codec-viewer';

/**
 * A lab (`/labs/codec`, listed on /labs; no sign-in needed) for exploring
 * documents in the experimental cochlea codec (`codec/`).
 */

const EXAMPLES: Record<string, () => Promise<{ default: unknown }>> = {
    drums: () => import('../../../codec/examples/drums.json'),
    gammatones: () => import('../../../codec/examples/gammatones.json'),
    'musicnet 1727 (as gammatones)': () => import('../../../codec/examples/musicnet-1727-gammatones.json'),
};

const Viewer = ({ document, maxDepth }: { document: unknown; maxDepth: number }) => {
    const ref = useRef<CodecViewer | null>(null);
    useLayoutEffect(() => {
        ref.current?.setAttribute('max-depth', String(maxDepth));
    }, [maxDepth]);
    useLayoutEffect(() => {
        if (ref.current && document !== null) ref.current.document = document;
    }, [document]);
    return <codec-viewer ref={ref} />;
};

export const CodecLab = () => {
    const [example, setExample] = useState(Object.keys(EXAMPLES)[0]!);
    const [document, setDocument] = useState<unknown>(null);
    const [text, setText] = useState('');
    const [maxDepth, setMaxDepth] = useState(2);
    const [jsonError, setJsonError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        EXAMPLES[example]!().then(({ default: doc }) => {
            if (cancelled) return;
            setDocument(doc);
            setText(JSON.stringify(doc, null, 2));
            setJsonError(null);
        });
        return () => {
            cancelled = true;
        };
    }, [example]);

    const apply = () => {
        try {
            setDocument(JSON.parse(text));
            setJsonError(null);
        } catch (e) {
            setJsonError((e as Error).message);
        }
    };

    return (
        <main className="page">
            <h1>Codec lab</h1>
            <p className="muted">
                An experimental audio codec whose encoded form is a JSON tree of parameters for a pluggable decoder
                (a sampler, a sequencer, and a gammatone extension), decoded by Rust compiled to WebAssembly in an
                AudioWorklet. See <code>codec/SPEC.md</code>.
            </p>
            <div className="row">
                <label className="inline">
                    Example
                    <select value={example} onChange={(e) => setExample(e.target.value)}>
                        {Object.keys(EXAMPLES).map((k) => (
                            <option key={k}>{k}</option>
                        ))}
                    </select>
                </label>
                <label className="inline">
                    Max depth
                    <input
                        type="number"
                        min={0}
                        max={20}
                        value={maxDepth}
                        onChange={(e) => setMaxDepth(Number(e.target.value))}
                        style={{ width: 56 }}
                    />
                </label>
            </div>
            <details className="panel">
                <summary>Edit JSON</summary>
                <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    spellCheck={false}
                    rows={18}
                    style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
                />
                <div className="row">
                    <button onClick={apply}>Apply</button>
                    {jsonError && <span className="error">{jsonError}</span>}
                </div>
            </details>
            <Viewer document={document} maxDepth={maxDepth} />
        </main>
    );
};
