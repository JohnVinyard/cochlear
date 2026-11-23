import type pg from 'pg';
import type { AnnotationSchemasDomain } from '../annotationSchemas';
import { validateAgainst } from '../shared/http/validation';
import type { SoundsDomain } from '../sounds';
import type { UsersDomain } from '../users';
import { type AnnotationsDomain, buildAnnotationsDomain } from './domain';
import { buildAnnotationsPersistence } from './adapters/postgres';

export { router } from './adapters/express';
export type { AnnotationsDomain };

export const buildAnnotations = (
    pool: pg.Pool,
    deps: { schemas: AnnotationSchemasDomain; sounds: SoundsDomain; users: UsersDomain }
): AnnotationsDomain =>
    buildAnnotationsDomain(buildAnnotationsPersistence(pool), { ...deps, validateJson: validateAgainst });
