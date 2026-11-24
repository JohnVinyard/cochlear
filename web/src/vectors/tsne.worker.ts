/**
 * Runs t-SNE off the main thread, posting positions as it goes so the plot
 * can show the layout settling:
 *
 *   in:   { vectors: number[][], iterations?, every?, options? }
 *   out:  { positions: Float32Array, iteration, done }   (repeatedly)
 *
 * Terminate the worker to cancel.
 */
import { Tsne, type TsneOptions } from './tsne';

interface Request {
    vectors: number[][];
    iterations?: number;
    every?: number;
    options?: TsneOptions;
}

self.onmessage = (e: MessageEvent<Request>) => {
    const { vectors, iterations = 1000, every = 10, options } = e.data;
    if (vectors.length < 2) {
        const positions = new Float32Array(vectors.length * (options?.dims ?? 3));
        self.postMessage({ positions, iteration: 0, done: true });
        return;
    }
    const tsne = new Tsne(vectors, options);
    while (tsne.iteration < iterations) {
        tsne.step();
        const done = tsne.iteration === iterations;
        if (done || tsne.iteration % every === 0) {
            const positions = tsne.positions;
            self.postMessage({ positions, iteration: tsne.iteration, done }, { transfer: [positions.buffer] });
        }
    }
};
