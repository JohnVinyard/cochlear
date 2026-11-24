/**
 * Colours for vectors: each one's projection onto the set's first three
 * principal components, as red, green and blue. Similar vectors get similar
 * colours, whatever their dimension.
 */

const dot = (a: Float64Array, b: Float64Array) => a.reduce((s, x, i) => s + x * b[i]!, 0);

/** The top `k` eigenvectors of a symmetric matrix, by power iteration with deflation */
function topEigenvectors(cov: Float64Array[], k: number): Float64Array[] {
    const d = cov.length;
    const found: Float64Array[] = [];
    for (let c = 0; c < Math.min(k, d); c++) {
        let v = Float64Array.from({ length: d }, (_, i) => Math.sin(i * 7.1 + c * 3.3) + 1.1); // deterministic start
        for (let iter = 0; iter < 100; iter++) {
            const next = new Float64Array(d);
            for (let i = 0; i < d; i++) next[i] = dot(cov[i]!, v);
            for (const u of found) {
                const p = dot(next, u);
                for (let i = 0; i < d; i++) next[i]! -= p * u[i]!;
            }
            const norm = Math.sqrt(dot(next, next));
            if (norm < 1e-12) break;
            for (let i = 0; i < d; i++) next[i]! /= norm;
            v = next;
        }
        found.push(v);
    }
    return found;
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;

/** [r, g, b] (0-255) per vector */
export function pcaColors(vectors: ArrayLike<number>[]): [number, number, number][] {
    const n = vectors.length;
    if (!n) return [];
    const d = vectors[0]!.length;
    const mean = new Float64Array(d);
    for (const v of vectors) for (let i = 0; i < d; i++) mean[i]! += v[i]! / n;
    const centred = vectors.map((v) => Float64Array.from({ length: d }, (_, i) => v[i]! - mean[i]!));
    const cov = Array.from({ length: d }, () => new Float64Array(d));
    for (const v of centred) for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) cov[i]![j]! += (v[i]! * v[j]!) / n;
    const axes = topEigenvectors(cov, 3);
    const projections = axes.map((axis) => centred.map((v) => dot(v, axis)));
    // map each component's 2nd-98th percentile onto 0-255, so outliers don't wash everything out
    const scaled = projections.map((p) => {
        const sorted = [...p].sort((a, b) => a - b);
        const lo = percentile(sorted, 0.02);
        const hi = percentile(sorted, 0.98);
        return p.map((x) => (hi > lo ? Math.min(1, Math.max(0, (x - lo) / (hi - lo))) : 0.5));
    });
    while (scaled.length < 3) scaled.push(Array(n).fill(0.5));
    return vectors.map((_, i) => [0, 1, 2].map((c) => Math.round(40 + scaled[c]![i]! * 200)) as [number, number, number]);
}
