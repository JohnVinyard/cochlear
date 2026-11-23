import { type BlobsDomain, buildBlobsDomain } from './domain';
import { buildGcsBlobStore, type GcsConfig } from './adapters/gcs';

export { router } from './adapters/express';
export type { BlobsDomain, GcsConfig };

export const buildBlobs = (config: GcsConfig): BlobsDomain => buildBlobsDomain(buildGcsBlobStore(config));
