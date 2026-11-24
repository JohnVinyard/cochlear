/**
 * Reads numpy `.npz` files (`np.savez`, `np.savez_compressed`) in the
 * browser: a zip of `.npy` arrays. No dependencies: zip entries are stored or
 * deflated (via DecompressionStream), and numpy writes zip64 headers.
 *
 * Every array comes back as a Float32Array in C order, whatever its dtype,
 * which is what drawing needs.
 */

export interface NdArray {
    shape: number[];
    dtype: string;
    data: Float32Array;
}

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

interface Entry {
    name: string;
    method: number;
    compressedSize: number;
    localOffset: number;
}

const fail = (message: string): never => {
    throw new Error(`not a readable .npz: ${message}`);
};

function entries(buf: ArrayBuffer): Entry[] {
    const v = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 0xffff); i--) {
        if (v.getUint32(i, true) === SIG_EOCD) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) fail('no zip directory');
    let count = v.getUint16(eocd + 10, true);
    let offset = v.getUint32(eocd + 16, true);
    if ((count === 0xffff || offset === 0xffffffff) && eocd >= 20 && v.getUint32(eocd - 20, true) === SIG_ZIP64_LOCATOR) {
        const z = Number(v.getBigUint64(eocd - 12, true));
        if (v.getUint32(z, true) !== SIG_ZIP64_EOCD) fail('bad zip64 directory');
        count = Number(v.getBigUint64(z + 32, true));
        offset = Number(v.getBigUint64(z + 48, true));
    }
    const decoder = new TextDecoder();
    const out: Entry[] = [];
    for (let i = 0, p = offset; i < count; i++) {
        if (v.getUint32(p, true) !== SIG_CENTRAL) fail('bad zip entry');
        const method = v.getUint16(p + 10, true);
        let compressedSize = v.getUint32(p + 20, true);
        let uncompressedSize = v.getUint32(p + 24, true);
        const nameLength = v.getUint16(p + 28, true);
        const extraLength = v.getUint16(p + 30, true);
        const commentLength = v.getUint16(p + 32, true);
        let localOffset = v.getUint32(p + 42, true);
        const name = decoder.decode(new Uint8Array(buf, p + 46, nameLength));
        // zip64 extra field: the 64-bit values of whichever fields are 0xffffffff, in this order
        for (let e = p + 46 + nameLength, end = e + extraLength; e + 4 <= end; ) {
            const id = v.getUint16(e, true);
            const size = v.getUint16(e + 2, true);
            if (id === 0x0001) {
                let q = e + 4;
                const next = () => {
                    const x = Number(v.getBigUint64(q, true));
                    q += 8;
                    return x;
                };
                if (uncompressedSize === 0xffffffff) uncompressedSize = next();
                if (compressedSize === 0xffffffff) compressedSize = next();
                if (localOffset === 0xffffffff) localOffset = next();
            }
            e += 4 + size;
        }
        out.push({ name, method, compressedSize, localOffset });
        p += 46 + nameLength + extraLength + commentLength;
    }
    return out;
}

async function inflate(bytes: Uint8Array): Promise<ArrayBuffer> {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer();
}

async function contents(buf: ArrayBuffer, entry: Entry): Promise<ArrayBuffer> {
    const v = new DataView(buf);
    const p = entry.localOffset;
    if (v.getUint32(p, true) !== SIG_LOCAL) fail(`bad local header for ${entry.name}`);
    const start = p + 30 + v.getUint16(p + 26, true) + v.getUint16(p + 28, true);
    const bytes = new Uint8Array(buf, start, entry.compressedSize);
    if (entry.method === 0) return bytes.slice().buffer;
    if (entry.method === 8) return inflate(bytes);
    return fail(`${entry.name} uses zip compression method ${entry.method}`);
}

/** Parses one `.npy` file */
export function parseNpy(buf: ArrayBuffer): NdArray {
    const bytes = new Uint8Array(buf);
    const magic = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]; // \x93NUMPY
    if (!magic.every((b, i) => bytes[i] === b)) fail('missing the .npy magic number');
    const v = new DataView(buf);
    const major = bytes[6]!;
    const headerLength = major === 1 ? v.getUint16(8, true) : v.getUint32(8, true);
    const headerStart = major === 1 ? 10 : 12;
    const header = new TextDecoder(major === 3 ? 'utf-8' : 'latin1').decode(
        bytes.subarray(headerStart, headerStart + headerLength)
    );
    const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1] ?? fail(`no dtype in ${header}`);
    const fortran = /'fortran_order':\s*True/.test(header);
    const shapeText = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1] ?? fail(`no shape in ${header}`);
    const shape = shapeText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number);
    const size = shape.reduce((a, b) => a * b, 1);
    const offset = headerStart + headerLength;

    const little = descr[0] !== '>';
    const kind = descr.slice(1);
    const width = Number(kind.slice(1));
    const read: Record<string, (o: number) => number> = {
        f4: (o) => v.getFloat32(o, little),
        f8: (o) => v.getFloat64(o, little),
        i1: (o) => v.getInt8(o),
        u1: (o) => v.getUint8(o),
        b1: (o) => v.getUint8(o),
        i2: (o) => v.getInt16(o, little),
        u2: (o) => v.getUint16(o, little),
        i4: (o) => v.getInt32(o, little),
        u4: (o) => v.getUint32(o, little),
        i8: (o) => Number(v.getBigInt64(o, little)),
        u8: (o) => Number(v.getBigUint64(o, little)),
        f2: (o) => halfToFloat(v.getUint16(o, little)),
    };
    const get = read[kind] ?? fail(`unsupported dtype ${descr}`);
    if (offset + size * width > buf.byteLength) fail('truncated array');

    let data: Float32Array;
    if (kind === 'f4' && little && offset % 4 === 0) {
        data = new Float32Array(buf, offset, size).slice();
    } else {
        data = new Float32Array(size);
        for (let i = 0; i < size; i++) data[i] = get(offset + i * width);
    }
    if (fortran && shape.length > 1) data = toCOrder(data, shape);
    return { shape, dtype: descr, data };
}

function halfToFloat(h: number): number {
    const sign = h & 0x8000 ? -1 : 1;
    const exponent = (h >> 10) & 0x1f;
    const fraction = h & 0x3ff;
    if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
    if (exponent === 31) return fraction ? NaN : sign * Infinity;
    return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** Fortran (column-major) to C (row-major) order */
function toCOrder(data: Float32Array, shape: number[]): Float32Array {
    const out = new Float32Array(data.length);
    const n = shape.length;
    const fStrides = shape.map((_, i) => shape.slice(0, i).reduce((a, b) => a * b, 1));
    const index = new Array<number>(n).fill(0);
    for (let c = 0; c < data.length; c++) {
        let f = 0;
        for (let k = 0; k < n; k++) f += index[k]! * fStrides[k]!;
        out[c] = data[f]!;
        for (let k = n - 1; k >= 0; k--) {
            if (++index[k]! < shape[k]!) break;
            index[k] = 0;
        }
    }
    return out;
}

/** Every array in an `.npz`, by name (without the `.npy` suffix) */
export async function parseNpz(buf: ArrayBuffer): Promise<Map<string, NdArray>> {
    const out = new Map<string, NdArray>();
    for (const entry of entries(buf)) {
        if (!entry.name.endsWith('.npy')) continue;
        out.set(entry.name.slice(0, -4), parseNpy(await contents(buf, entry)));
    }
    return out;
}
