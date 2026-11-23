import type pg from 'pg';
import { isValidJsonSchema } from '../shared/http/validation';
import { type AnnotationSchemasDomain, buildAnnotationSchemasDomain } from './domain';
import { buildAnnotationSchemasPersistence } from './adapters/postgres';

export { router } from './adapters/express';
export type { AnnotationSchemasDomain };

export const buildAnnotationSchemas = (pool: pg.Pool): AnnotationSchemasDomain =>
    buildAnnotationSchemasDomain(buildAnnotationSchemasPersistence(pool), isValidJsonSchema);
