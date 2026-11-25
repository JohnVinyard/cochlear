import { createHash } from 'node:crypto';
import { hasRole, type Principal, requireRole } from '../auth/domain';
import { InvalidRequest } from '../shared/errors';

/**
 * Blobs are opaque binary payloads (typically `.npz` files of time-varying
 * features) referenced by `blob` annotations.  They're content-addressed:
 * uploading the same bytes twice yields the same URL.
 */
export interface StoredBlob {
    key: string;
    url: string;
    contentType: string;
    sizeBytes: number;
}

export interface BlobStore {
    /** Idempotent;  returns the blob's public URL */
    put(key: string, bytes: Buffer, contentType: string): Promise<string>;
}

export interface BlobsDomain {
    uploadBlob(actor: Principal, bytes: Buffer, contentType: string): Promise<StoredBlob>;
}

export const MAX_BLOB_BYTES = 50 * 1024 * 1024;

/** Blobs only exist to be referenced by annotations, so creating annotations is what lets you upload them */
export const blobPolicy = {
    upload: (actor: Principal) => hasRole(actor, 'ANNOTATION_EDITOR'),
};

export const blobKey = (bytes: Buffer): string => `sha256/${createHash('sha256').update(bytes).digest('hex')}`;

export const buildBlobsDomain = (store: BlobStore): BlobsDomain => ({
    async uploadBlob(actor, bytes, contentType) {
        requireRole(actor, 'ANNOTATION_EDITOR');
        const errors: string[] = [];
        if (!bytes.length) errors.push('blob must not be empty');
        if (bytes.length > MAX_BLOB_BYTES) errors.push(`blob must be at most ${MAX_BLOB_BYTES} bytes`);
        if (!/^[\w.+-]+\/[\w.+-]+$/.test(contentType)) errors.push('a valid Content-Type header is required');
        if (errors.length) throw new InvalidRequest(errors);
        const key = blobKey(bytes);
        const url = await store.put(key, bytes, contentType);
        return { key, url, contentType, sizeBytes: bytes.length };
    },
});
