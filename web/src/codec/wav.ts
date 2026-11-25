/** Mono 16-bit PCM WAV. Samples beyond ±1 are clipped (see `peak` to avoid that). */
export const encodeWav = (samples: Float32Array, sampleRate: number): Blob => {
    const bytes = samples.length * 2;
    const buffer = new ArrayBuffer(44 + bytes);
    const v = new DataView(buffer);
    const text = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
    text(0, 'RIFF');
    v.setUint32(4, 36 + bytes, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, 1, true); // mono
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    text(36, 'data');
    v.setUint32(40, bytes, true);
    const pcm = new Int16Array(buffer, 44, samples.length);
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]!));
        pcm[i] = s < 0 ? s * 32768 : s * 32767;
    }
    return new Blob([buffer], { type: 'audio/wav' });
};

/** The largest absolute sample */
export const peak = (samples: Float32Array): number => {
    let max = 0;
    for (let i = 0; i < samples.length; i++) max = Math.max(max, Math.abs(samples[i]!));
    return max;
};

/** Offers a blob as a download */
export const saveBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};
