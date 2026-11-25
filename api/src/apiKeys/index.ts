import type pg from 'pg';
import { type ApiKeysDomain, buildApiKeysDomain, isApiKeySecret } from './domain';
import { buildApiKeysPersistence } from './adapters/postgres';

export { router } from './adapters/express';
/** For other features' links to create API keys */
export { default as createApiKeySchema } from './adapters/createApiKeyRequestBody.schema.json';
export { isApiKeySecret };
export type { ApiKeysDomain };

export const buildApiKeys = (pool: pg.Pool): ApiKeysDomain => buildApiKeysDomain(buildApiKeysPersistence(pool));
