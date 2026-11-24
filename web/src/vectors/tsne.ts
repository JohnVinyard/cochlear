/**
 * Exact t-SNE (van der Maaten & Hinton, 2008), in any number of output
 * dimensions (3 here). O(N²) per iteration, which is fine for the few hundred
 * points of a search result; for thousands, Barnes-Hut would be the next step.
 *
 * Inputs are L2-normalised first, so distances between them are cosine
 * distances (as in vector search), whatever the vectors' scale.
 *
 *     const tsne = new Tsne(vectors, { perplexity: 30 });
 *     while (tsne.iteration < 1000) tsne.step();
 *     tsne.positions  // Float32Array, N * dims, row-major
 */

export interface TsneOptions {
    dims?: number;
    perplexity?: number;
    /** Default: N / earlyExaggeration / 4, at least 50 (Belkina et al., 2019) */
    learningRate?: number;
    earlyExaggeration?: number;
    exaggerationIterations?: number;
    seed?: number;
}

/** mulberry32: a small, seedable PRNG, so a layout is reproducible */
const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const gaussian = (rand: () => number) => {
    const u = Math.max(rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
};

/** Squared distances between L2-normalised rows */
const squaredDistances = (vectors: ArrayLike<number>[]): Float64Array => {
    const n = vectors.length;
    const unit = vectors.map((v) => {
        let norm = 0;
        for (let k = 0; k < v.length; k++) norm += v[k]! * v[k]!;
        norm = Math.sqrt(norm) || 1;
        return Float64Array.from(v, (x) => x / norm);
    });
    const d = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const a = unit[i]!;
            const b = unit[j]!;
            let s = 0;
            for (let k = 0; k < a.length; k++) s += (a[k]! - b[k]!) ** 2;
            d[i * n + j] = d[j * n + i] = s;
        }
    }
    return d;
};

/**
 * Joint probabilities P: each point's Gaussian bandwidth is found by binary
 * search so its conditional distribution has the given perplexity, then
 * P = (P_j|i + P_i|j) / 2N.
 */
const jointProbabilities = (d: Float64Array, n: number, perplexity: number): Float64Array => {
    const target = Math.log(perplexity);
    const p = new Float64Array(n * n);
    const row = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let beta = 1;
        let lo = -Infinity;
        let hi = Infinity;
        for (let tries = 0; tries < 64; tries++) {
            let sum = 0;
            for (let j = 0; j < n; j++) {
                row[j] = j === i ? 0 : Math.exp(-d[i * n + j]! * beta);
                sum += row[j]!;
            }
            sum = sum || 1e-12;
            let entropy = 0;
            for (let j = 0; j < n; j++) {
                const pj = row[j]! / sum;
                if (pj > 1e-12) entropy -= pj * Math.log(pj);
            }
            for (let j = 0; j < n; j++) row[j]! /= sum;
            if (Math.abs(entropy - target) < 1e-5) break;
            // too much entropy: the Gaussian is too wide, so narrow it (raise beta)
            if (entropy > target) {
                lo = beta;
                beta = hi === Infinity ? beta * 2 : (beta + hi) / 2;
            } else {
                hi = beta;
                beta = lo === -Infinity ? beta / 2 : (beta + lo) / 2;
            }
        }
        p.set(row, i * n);
    }
    const joint = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            joint[i * n + j] = Math.max((p[i * n + j]! + p[j * n + i]!) / (2 * n), 1e-12);
        }
    }
    return joint;
};

export class Tsne {
    readonly n: number;
    readonly dims: number;
    iteration = 0;
    private readonly p: Float64Array;
    private readonly y: Float64Array;
    private readonly velocity: Float64Array;
    private readonly gains: Float64Array;
    private readonly gradient: Float64Array;
    /** Student-t affinities, reused between steps */
    private readonly num: Float64Array;
    private readonly options: Required<TsneOptions>;

    constructor(vectors: ArrayLike<number>[], options: TsneOptions = {}) {
        this.n = vectors.length;
        const exaggeration = options.earlyExaggeration ?? 12;
        this.options = {
            dims: 3,
            perplexity: 30,
            earlyExaggeration: exaggeration,
            exaggerationIterations: 250,
            seed: 1,
            learningRate: Math.max(50, this.n / exaggeration / 4),
            ...options,
        };
        this.dims = this.options.dims;
        // perplexity can't exceed what N points can provide
        const perplexity = Math.max(1, Math.min(this.options.perplexity, (this.n - 1) / 3));
        this.p = jointProbabilities(squaredDistances(vectors), this.n, perplexity);
        const rand = random(this.options.seed);
        this.y = Float64Array.from({ length: this.n * this.dims }, () => gaussian(rand) * 1e-4);
        this.velocity = new Float64Array(this.n * this.dims);
        this.gains = new Float64Array(this.n * this.dims).fill(1);
        this.gradient = new Float64Array(this.n * this.dims);
        this.num = new Float64Array(this.n * this.n);
    }

    /** One gradient descent step */
    step(): void {
        const { n, dims, y, p, gradient, gains, velocity, num } = this;
        const { earlyExaggeration, exaggerationIterations, learningRate } = this.options;
        const exaggerate = this.iteration < exaggerationIterations ? earlyExaggeration : 1;
        const momentum = this.iteration < exaggerationIterations ? 0.5 : 0.8;

        // Student-t affinities in the embedding: num_ij = 1 / (1 + |y_i - y_j|²)
        let z = 0;
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                let s = 0;
                for (let k = 0; k < dims; k++) s += (y[i * dims + k]! - y[j * dims + k]!) ** 2;
                const q = 1 / (1 + s);
                num[i * n + j] = num[j * n + i] = q;
                z += 2 * q;
            }
        }
        // dC/dy_i = 4 Σ_j (P_ij - Q_ij) num_ij (y_i - y_j)
        gradient.fill(0);
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                if (i === j) continue;
                const q = num[i * n + j]!;
                const m = 4 * (exaggerate * p[i * n + j]! - q / z) * q;
                for (let k = 0; k < dims; k++) gradient[i * dims + k]! += m * (y[i * dims + k]! - y[j * dims + k]!);
            }
        }
        // per-parameter gains (delta-bar-delta), momentum, and recentring
        const mean = new Float64Array(dims);
        for (let i = 0; i < n * dims; i++) {
            const g = gradient[i]!;
            gains[i] = Math.max(0.01, Math.sign(g) === Math.sign(velocity[i]!) ? gains[i]! * 0.8 : gains[i]! + 0.2);
            velocity[i] = momentum * velocity[i]! - learningRate * gains[i]! * g;
            y[i]! += velocity[i]!;
            mean[i % dims]! += y[i]! / n;
        }
        for (let i = 0; i < n * dims; i++) y[i]! -= mean[i % dims]!;
        this.iteration++;
    }

    get positions(): Float32Array {
        return Float32Array.from(this.y);
    }
}
