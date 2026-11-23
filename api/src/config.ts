import { dbConfigFromEnv, type DbConfig } from './shared/db/pool';
import type { GcsConfig } from './blobs';

export interface Config {
    port: number;
    /** Base for all absolute links in responses, e.g. `http://localhost:8080` */
    publicBaseUrl: string;
    corsOrigins: string[];
    firebaseProjectId: string;
    db: DbConfig;
    blobs: GcsConfig;
}

const required = (env: NodeJS.ProcessEnv, name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing required environment variable ${name}`);
    return value;
};

export const configFromEnv = (env = process.env): Config => ({
    port: Number(env.PORT ?? 8080),
    publicBaseUrl: required(env, 'PUBLIC_BASE_URL'),
    corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    firebaseProjectId: required(env, 'FIREBASE_PROJECT_ID'),
    db: dbConfigFromEnv(env),
    blobs: {
        bucket: required(env, 'BLOB_BUCKET'),
        projectId: required(env, 'FIREBASE_PROJECT_ID'),
        publicUrlTemplate: required(env, 'BLOB_PUBLIC_URL_TEMPLATE'),
        createBucket: env.BLOB_CREATE_BUCKET === 'true',
        apiEndpoint: env.GCS_API_ENDPOINT || null,
    },
});
