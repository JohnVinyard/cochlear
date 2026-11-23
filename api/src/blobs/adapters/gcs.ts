import { Storage } from '@google-cloud/storage';
import type { BlobStore } from '../domain';

export interface GcsConfig {
    bucket: string;
    projectId: string;
    /** e.g. `https://storage.googleapis.com/my-bucket/{key}`;  `{key}` is URL-encoded */
    publicUrlTemplate: string;
    /** Create the bucket if it doesn't exist (local development only) */
    createBucket: boolean;
    /** Override the GCS endpoint, e.g. `http://gcs:4443` for fake-gcs-server (unauthenticated) */
    apiEndpoint: string | null;
}

/**
 * Google Cloud Storage blob store.  Locally, `apiEndpoint` points it at
 * fake-gcs-server (requests are then unauthenticated).
 */
export const buildGcsBlobStore = (config: GcsConfig): BlobStore => {
    const storage = new Storage({
        projectId: config.projectId,
        ...(config.apiEndpoint ? { apiEndpoint: config.apiEndpoint, useAuthWithCustomEndpoint: false } : {}),
    });
    const bucket = storage.bucket(config.bucket);
    let ready: Promise<void> | null = null;

    const ensureBucket = () =>
        (ready ??= (async () => {
            if (!config.createBucket) return;
            const [exists] = await bucket.exists();
            if (!exists) await storage.createBucket(config.bucket);
        })().catch((err) => {
            ready = null;
            throw err;
        }));

    return {
        async put(key, bytes, contentType) {
            await ensureBucket();
            const file = bucket.file(key);
            const [exists] = await file.exists();
            if (!exists) {
                await file.save(bytes, { contentType, resumable: false });
            }
            return config.publicUrlTemplate.replace('{key}', encodeURIComponent(key));
        },
    };
};
