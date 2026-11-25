import type pg from 'pg';
import type { AnnotationSchemasDomain } from '../annotationSchemas/domain';
import { validateAgainst } from '../shared/http/validation';
import type { SoundsDomain } from '../sounds/domain';
import type { UsersDomain } from '../users/domain';
import { type AnnotationsDomain, buildAnnotationsDomain } from './domain';
import { buildAnnotationsPersistence } from './adapters/postgres';

export { router } from './adapters/express';
/** For other features' links to create annotations */
export { default as createAnnotationsSchema } from './adapters/createAnnotationsRequestBody.schema.json';
export type { AnnotationsDomain };

export const buildAnnotations = (
    pool: pg.Pool,
    deps: { schemas: AnnotationSchemasDomain; sounds: SoundsDomain; users: UsersDomain }
): AnnotationsDomain =>
    buildAnnotationsDomain(buildAnnotationsPersistence(pool), { ...deps, validateJson: validateAgainst });
