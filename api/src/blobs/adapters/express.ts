import express, { Router } from 'express';
import { principalOf } from '../../auth/adapters/express';
import { MAX_BLOB_BYTES, type BlobsDomain } from '../domain';

export const router = (domain: BlobsDomain): Router => {
    const r = Router();

    r.post('/blobs', express.raw({ type: () => true, limit: MAX_BLOB_BYTES }), async (req, res) => {
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const blob = await domain.uploadBlob(principalOf(res), body, req.header('content-type') ?? '');
        res.status(201).location(blob.url).json({
            url: blob.url,
            content_type: blob.contentType,
            size_bytes: blob.sizeBytes,
        });
    });

    return r;
};
