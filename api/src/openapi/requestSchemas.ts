/**
 * Every JSON request body schema, by `$id`. They're the same objects the
 * express adapters validate against; the API serves each at
 * `GET /schemas/{$id}` (the `schema` of an action link), and the OpenAPI spec
 * includes them as components.
 */
import createAnnotationSchema from '../annotationSchemas/adapters/createAnnotationSchemaRequestBody.schema.json';
import createAnnotations from '../annotations/adapters/createAnnotationsRequestBody.schema.json';
import createApiKey from '../apiKeys/adapters/createApiKeyRequestBody.schema.json';
import { createSoundFormatSchema, createSoundSchema } from '../sounds/adapters/express';
import putMyState from '../users/adapters/putMyStateRequestBody.schema.json';
import updateMe from '../users/adapters/updateMeRequestBody.schema.json';

type Json = Record<string, unknown>;

export const SCHEMAS = {
    createSound: createSoundSchema,
    createSoundFormat: createSoundFormatSchema,
    createAnnotations,
    createAnnotationSchema,
    createApiKey,
    updateMe,
    putMyState,
};

/** By `$id` */
export const REQUEST_SCHEMAS: ReadonlyMap<string, Json & { $id: string }> = new Map(
    Object.values(SCHEMAS).map((s) => [s.$id, s])
);

/**
 * A schema as served: a standalone draft-07 document whose `$id` is the URL
 * it's served from.
 */
export const servedSchema = (schema: Json, href: string): Json => ({
    $schema: 'http://json-schema.org/draft-07/schema#',
    ...schema,
    $id: href,
});
