/**
 * Hand-written OpenAPI 3.1 description of the API.  Request-body and query
 * schemas are imported from the same `*.schema.json` files the express
 * adapters validate against, so they cannot drift.  The API test suite
 * checks that the spec is valid, and that every operation in it is routed.
 */
import { ANNOTATION_KINDS, LICENSE_TYPES, ROLES } from '@cochlea/shared';
import createAnnotationSchema from '../annotationSchemas/adapters/createAnnotationSchemaRequestBody.schema.json';
import annotationFeedQuery from '../annotations/adapters/annotationFeedQuery.schema.json';
import createAnnotations from '../annotations/adapters/createAnnotationsRequestBody.schema.json';
import similarQuery from '../annotations/adapters/similarQuery.schema.json';
import createApiKey from '../apiKeys/adapters/createApiKeyRequestBody.schema.json';
import { createSoundFormatSchema, createSoundSchema } from '../sounds/adapters/express';
import soundFeedQuery from '../sounds/adapters/soundFeedQuery.schema.json';
import updateMe from '../users/adapters/updateMeRequestBody.schema.json';

type Json = Record<string, unknown>;

/** OpenAPI component schemas may not carry `$id`s that collide with refs */
const strip = ({ $id: _id, ...schema }: Json): Json => schema;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const json = (schema: Json) => ({ 'application/json': { schema } });

const errorResponse = (description: string) => ({ description, content: json(ref('Error')) });

const STANDARD_ERRORS = {
    '400': errorResponse('Invalid request'),
    '401': errorResponse('Missing or invalid credentials'),
    '403': errorResponse('Insufficient privileges'),
};

const ok = (schema: Json, description = 'OK') => ({
    '200': { description, content: json(schema) },
    ...STANDARD_ERRORS,
});

const created = (schema: Json) => ({
    '201': { description: 'Created', content: json(schema) },
    ...STANDARD_ERRORS,
});

const noContent = { '204': { description: 'Deleted' }, ...STANDARD_ERRORS, '404': errorResponse('Not found') };

const pathParam = (name: string, description: string, schema: Json = { type: 'integer', minimum: 1 }) => ({
    name,
    in: 'path',
    required: true,
    description,
    schema,
});

/** Turns a flat JSON schema for a query string into OpenAPI parameters */
const queryParams = (schema: { properties: Record<string, Json> }, omit: string[] = []) =>
    Object.entries(schema.properties)
        .filter(([name]) => !omit.includes(name))
        .map(([name, s]) => ({ name, in: 'query', required: false, schema: s }));

const feedParams = queryParams({
    properties: {
        low_id: { type: 'string', pattern: '^[0-9]+$', description: 'Return items with ids greater than this' },
        page_size: { type: 'string', description: '1-500, default 100' },
    },
});

const page = (item: string) => ({
    type: 'object',
    required: ['items', 'links'],
    properties: {
        items: { type: 'array', items: ref(item) },
        next: { type: 'string', format: 'uri', description: 'Present when more items exist' },
        links: ref('Links'),
    },
});

const nullableString = { type: ['string', 'null'] };

/**
 * Operations are grouped by resource (OpenAPI tags), which is how doc
 * viewers like Stoplight Elements build their navigation. The first rule
 * whose pattern matches a path tags all of its operations; sub-resources
 * belong with what they return (a user's sounds are sounds). The tags'
 * order here is the order viewers show them in.
 */
export const TAGS: { name: string; description: string; paths: RegExp }[] = [
    {
        name: 'Discovery',
        description: 'The entry point, with links to every top-level resource',
        paths: /^\/$/,
    },
    {
        name: 'Sounds',
        description: 'Audio that lives elsewhere on the internet, registered by URL. Immutable; a feed, oldest first.',
        paths: /^\/(sounds(\/\{sound_id\}(\/formats(\/\{format_id\})?)?)?|users\/\{user_id\}\/sounds)$/,
    },
    {
        name: 'Annotations',
        description:
            'Immutable descriptions of a sound, or a segment of one, typed by an annotation schema. A feed, oldest first.',
        paths: /^\/(annotations(\/\{annotation_id\})?|sounds\/\{sound_id\}\/annotations|users\/\{user_id\}\/annotations)$/,
    },
    {
        name: 'Search',
        description: 'Similarity search over vector annotations; each vector schema has its own index',
        paths: /^\/annotations\/\{annotation_id\}\/similar$/,
    },
    {
        name: 'Annotation schemas',
        description: 'Named, versioned, immutable types for annotations: their kind, vector size and JSON schema',
        paths: /^\/annotation-schemas/,
    },
    {
        name: 'Blobs',
        description: 'Binary payloads (e.g. .npz features) for blob annotations, stored by content hash',
        paths: /^\/blobs$/,
    },
    {
        name: 'Users',
        description: 'Profiles, and each user\'s private state document (e.g. a bot\'s feed cursor)',
        paths: /^\/users\//,
    },
    {
        name: 'API keys',
        description: 'Keys for scripts and bots, with a subset of your roles. Managed from the web app only.',
        paths: /^\/api-keys/,
    },
];

const METHODS = ['get', 'put', 'post', 'patch', 'delete'] as const;

/**
 * Tags every operation by the first rule whose pattern matches its path, and
 * orders the paths to match (viewers list a tag's operations in path order):
 * by tag, then a resource's own paths before the ones reached through another
 * resource (`/sounds` before `/users/{user_id}/sounds`).
 */
const tagged = <T extends { paths: Record<string, Record<string, unknown>> }>(spec: T): T & { tags: object[] } => {
    const tagOf = (path: string) => TAGS.findIndex((t) => t.paths.test(path));
    const nested = (path: string) => Number(!path.startsWith(`/${TAGS[tagOf(path)]?.name.toLowerCase().replace(' ', '-')}`));
    const entries = Object.entries(spec.paths).map(([path, item], i) => ({ path, item, i }));
    entries.sort((a, b) => tagOf(a.path) - tagOf(b.path) || nested(a.path) - nested(b.path) || a.i - b.i);
    for (const { path, item } of entries) {
        const tag = TAGS[tagOf(path)];
        for (const method of METHODS) {
            const operation = item[method] as { tags?: string[] } | undefined;
            if (operation && tag) operation.tags = [tag.name];
        }
    }
    return {
        ...spec,
        paths: Object.fromEntries(entries.map(({ path, item }) => [path, item])),
        tags: TAGS.map(({ name, description }) => ({ name, description })),
    };
};

export const buildOpenApiSpec = (serverUrl: string) =>
    tagged({
        openapi: '3.1.0',
        info: {
            title: 'Cochlea',
            version: '0.1.0',
            description: [
                'Describe audio on the internet with annotations.',
                '',
                'Every request requires `Authorization: Bearer <token>`, where the token is either a',
                'firebase ID token (web app) or an API key (`cka_...`).',
                '',
                '`/sounds` and `/annotations` are feeds:  items are returned oldest-first, and',
                'consumers can poll with `low_id=<last id seen>`.  Ids become visible in order, so',
                'a consumer never skips an item.',
            ].join('\n'),
        },
        servers: [{ url: serverUrl }],
        security: [{ bearer: [] }],
        components: {
            securitySchemes: {
                bearer: {
                    type: 'http',
                    scheme: 'bearer',
                    description: 'A firebase ID token, or an API key of the form `cka_<43 characters>`',
                },
            },
            schemas: {
                Error: {
                    type: 'object',
                    required: ['errors'],
                    properties: { errors: { type: 'array', items: { type: 'string' } } },
                },
                Links: { type: 'object', additionalProperties: { type: 'string', format: 'uri' } },
                Role: { type: 'string', enum: [...ROLES] },
                Access: {
                    description: 'null: only the creator; "*": any authenticated user; [ids]: these users (and the creator)',
                    oneOf: [
                        { type: 'null' },
                        { type: 'string', const: '*' },
                        { type: 'array', items: { type: 'integer' } },
                    ],
                },
                User: {
                    type: 'object',
                    required: ['id', 'user_name', 'about_me', 'info_url', 'created_at', 'links'],
                    properties: {
                        id: { type: 'integer' },
                        user_name: { type: 'string' },
                        about_me: { type: 'string' },
                        info_url: nullableString,
                        created_at: { type: 'string', format: 'date-time' },
                        email: { ...nullableString, description: 'Only present for yourself' },
                        roles: { type: 'array', items: ref('Role'), description: 'Only present for yourself' },
                        links: ref('Links'),
                    },
                },
                ApiKey: {
                    type: 'object',
                    required: ['id', 'name', 'prefix', 'roles', 'created_at', 'links'],
                    properties: {
                        id: { type: 'integer' },
                        name: { type: 'string' },
                        prefix: { type: 'string', description: 'The first characters of the secret, for identification' },
                        roles: { type: 'array', items: ref('Role') },
                        created_at: { type: 'string', format: 'date-time' },
                        links: ref('Links'),
                    },
                },
                CreatedApiKey: {
                    allOf: [
                        ref('ApiKey'),
                        {
                            type: 'object',
                            required: ['secret'],
                            properties: { secret: { type: 'string', description: 'Only ever returned once' } },
                        },
                    ],
                },
                Sound: {
                    type: 'object',
                    required: ['id', 'created_at', 'created_by', 'audio_url', 'license_type', 'duration_seconds', 'links'],
                    properties: {
                        id: { type: 'integer' },
                        created_at: { type: 'string', format: 'date-time' },
                        created_by: { type: 'integer' },
                        audio_url: { type: 'string', format: 'uri' },
                        info_url: nullableString,
                        license_type: { type: 'string', enum: [...LICENSE_TYPES] },
                        title: nullableString,
                        duration_seconds: { type: 'number' },
                        formats: { type: 'array', items: ref('SoundFormat'), description: 'Other encodings of the audio' },
                        links: ref('Links'),
                    },
                },
                SoundFormat: {
                    type: 'object',
                    description:
                        'An encoding of a sound: another file with the same audio. Immutable; anyone with SOUND_EDITOR ' +
                        'may add one to any sound, and only its creator may delete it.',
                    required: ['id', 'sound_id', 'url', 'mime_type', 'metadata', 'created_by', 'created_at', 'links'],
                    properties: {
                        id: { type: 'integer' },
                        sound_id: { type: 'integer' },
                        url: { type: 'string', format: 'uri' },
                        mime_type: { type: 'string', description: 'e.g. audio/mpeg, audio/wav, audio/vnd.cochlea.sprs+json' },
                        metadata: { type: 'object', description: 'Varies by type: sample_rate, channels, bit_depth...' },
                        created_by: { type: 'integer' },
                        created_at: { type: 'string', format: 'date-time' },
                        links: ref('Links'),
                    },
                },
                AnnotationSchema: {
                    type: 'object',
                    required: ['id', 'name', 'version', 'ref', 'kind', 'created_at', 'created_by', 'links'],
                    properties: {
                        id: { type: 'integer' },
                        name: { type: 'string' },
                        version: { type: 'integer' },
                        ref: { type: 'string', description: 'name@version' },
                        kind: { type: 'string', enum: [...ANNOTATION_KINDS] },
                        vector_dim: { type: ['integer', 'null'] },
                        json_schema: { type: ['object', 'null'] },
                        description: { type: 'string' },
                        created_at: { type: 'string', format: 'date-time' },
                        annotation_count: {
                            type: 'integer',
                            description: "Public, live annotations of this schema (private ones aren't counted)",
                        },
                        created_by: { type: 'integer' },
                        links: ref('Links'),
                    },
                },
                Annotation: {
                    type: 'object',
                    required: ['id', 'created_at', 'created_by', 'sound_id', 'schema', 'kind', 'links'],
                    properties: {
                        id: { type: 'integer' },
                        created_at: { type: 'string', format: 'date-time' },
                        created_by: { type: 'integer' },
                        sound_id: { type: 'integer' },
                        schema: { type: 'string', description: 'name@version' },
                        kind: { type: 'string', enum: [...ANNOTATION_KINDS] },
                        start_seconds: { type: ['number', 'null'] },
                        duration_seconds: { type: ['number', 'null'] },
                        end_seconds: { type: ['number', 'null'] },
                        tags: { type: 'array', items: { type: 'string' } },
                        text: { type: 'string' },
                        vector: { type: 'array', items: { type: 'number' } },
                        kv: { type: 'object' },
                        blob: {
                            type: 'object',
                            properties: { url: { type: 'string' }, content_type: { type: 'string' } },
                        },
                        data: {},
                        access: { ...ref('Access'), description: 'Only shown to the creator' },
                        links: ref('Links'),
                    },
                },
                Blob: {
                    type: 'object',
                    required: ['url', 'content_type', 'size_bytes'],
                    properties: {
                        url: { type: 'string', format: 'uri' },
                        content_type: { type: 'string' },
                        size_bytes: { type: 'integer' },
                    },
                },
                UpdateMeRequestBody: strip(updateMe),
                CreateApiKeyRequestBody: strip(createApiKey),
                CreateSoundRequestBody: strip(createSoundSchema),
                CreateSoundFormatRequestBody: strip(createSoundFormatSchema),
                CreateAnnotationSchemaRequestBody: strip(createAnnotationSchema),
                CreateAnnotationsRequestBody: strip(createAnnotations),
            },
        },
        paths: {
            '/': {
                get: {
                    summary: 'Entry point;  links to every top-level resource',
                    responses: ok({ type: 'object', properties: { links: ref('Links') } }),
                },
            },
            '/users/me': {
                get: { summary: 'The authenticated user (auto-provisioned on first sign-in)', responses: ok(ref('User')) },
                patch: {
                    summary: 'Update your profile',
                    requestBody: { required: true, content: json(ref('UpdateMeRequestBody')) },
                    responses: ok(ref('User')),
                },
            },
            '/users/me/state': {
                get: {
                    summary: 'Your state document',
                    description:
                        'A small, private, machine-readable JSON object, e.g. a bot\'s feed cursor. It starts as {}. ' +
                        'The ETag header is its version; clear-data resets it.',
                    responses: ok({ type: 'object' }),
                },
                put: {
                    summary: 'Replace your state document',
                    description:
                        'At most 64 KB of JSON. Send If-Match with the ETag you last saw to write only if nobody else ' +
                        'has since (another instance of a bot, or a clear-data): otherwise 412.',
                    parameters: [
                        {
                            name: 'If-Match',
                            in: 'header',
                            required: false,
                            description: 'An ETag from GET or PUT, e.g. "7"',
                            schema: { type: 'string' },
                        },
                    ],
                    requestBody: { required: true, content: json({ type: 'object' }) },
                    responses: {
                        ...ok({ type: 'object' }),
                        '412': errorResponse('The state has changed since the If-Match version'),
                    },
                },
            },
            '/users/{user_id}': {
                parameters: [pathParam('user_id', 'User id')],
                get: { summary: 'A user', responses: { ...ok(ref('User')), '404': errorResponse('Not found') } },
            },
            '/users/{user_id}/sounds': {
                parameters: [pathParam('user_id', 'User id')],
                get: {
                    summary: 'Feed of sounds created by a user',
                    parameters: feedParams,
                    responses: ok(page('Sound')),
                },
            },
            '/users/{user_id}/annotations': {
                parameters: [pathParam('user_id', 'User id')],
                get: {
                    summary: 'Feed of (visible) annotations created by a user',
                    parameters: queryParams(annotationFeedQuery, ['created_by', 'time_range']),
                    responses: ok(page('Annotation')),
                },
            },
            '/api-keys': {
                get: {
                    summary: 'Your active API keys (web app only)',
                    responses: ok({ type: 'object', properties: { items: { type: 'array', items: ref('ApiKey') } } }),
                },
                post: {
                    summary: 'Create an API key with a subset of your roles (web app only)',
                    requestBody: { required: true, content: json(ref('CreateApiKeyRequestBody')) },
                    responses: created(ref('CreatedApiKey')),
                },
            },
            '/api-keys/{api_key_id}': {
                parameters: [pathParam('api_key_id', 'API key id')],
                delete: { summary: 'Revoke an API key (web app only)', responses: noContent },
            },
            '/sounds': {
                get: {
                    summary: 'Feed of sounds, oldest first',
                    parameters: queryParams(soundFeedQuery),
                    responses: ok(page('Sound')),
                },
                post: {
                    summary: 'Register a sound that is available on the internet',
                    requestBody: { required: true, content: json(ref('CreateSoundRequestBody')) },
                    responses: {
                        ...created(ref('Sound')),
                        '409': {
                            description: 'A sound with this audio_url exists;  `Location` points to it',
                            content: json(ref('Error')),
                        },
                    },
                },
            },
            '/sounds/{sound_id}': {
                parameters: [pathParam('sound_id', 'Sound id')],
                get: {
                    summary: 'A sound',
                    responses: { ...ok(ref('Sound')), '404': errorResponse('Not found'), '410': errorResponse('Deleted') },
                },
                delete: { summary: "Delete a sound (creator only)", responses: noContent },
            },
            '/sounds/{sound_id}/formats': {
                parameters: [pathParam('sound_id', 'Sound id')],
                get: {
                    summary: "A sound's encodings",
                    responses: {
                        ...ok({ type: 'object', properties: { items: { type: 'array', items: ref('SoundFormat') } } }),
                        '404': errorResponse('Not found'),
                        '410': errorResponse('Deleted'),
                    },
                },
                post: {
                    summary: 'Add an encoding of a sound (any sound; SOUND_EDITOR)',
                    requestBody: { required: true, content: json(ref('CreateSoundFormatRequestBody')) },
                    responses: {
                        ...created(ref('SoundFormat')),
                        '409': errorResponse('The sound already has a format at this URL (Location: the existing one)'),
                    },
                },
            },
            '/sounds/{sound_id}/formats/{format_id}': {
                parameters: [pathParam('sound_id', 'Sound id'), pathParam('format_id', 'Format id')],
                get: {
                    summary: 'An encoding of a sound',
                    responses: { ...ok(ref('SoundFormat')), '404': errorResponse('Not found'), '410': errorResponse('Deleted') },
                },
                delete: { summary: 'Delete an encoding (its creator only)', responses: noContent },
            },
            '/sounds/{sound_id}/annotations': {
                parameters: [pathParam('sound_id', 'Sound id')],
                get: {
                    summary: "Feed of a sound's (visible) annotations",
                    parameters: queryParams(annotationFeedQuery),
                    responses: ok(page('Annotation')),
                },
                post: {
                    summary: 'Create up to 500 annotations, atomically',
                    requestBody: { required: true, content: json(ref('CreateAnnotationsRequestBody')) },
                    responses: created({
                        type: 'object',
                        properties: { items: { type: 'array', items: ref('Annotation') }, links: ref('Links') },
                    }),
                },
            },
            '/annotation-schemas': {
                get: { summary: 'All annotation schemas', parameters: feedParams, responses: ok(page('AnnotationSchema')) },
                post: {
                    summary: 'Publish a schema, or the next version of one you own',
                    requestBody: { required: true, content: json(ref('CreateAnnotationSchemaRequestBody')) },
                    responses: created(ref('AnnotationSchema')),
                },
            },
            '/annotation-schemas/{ref}': {
                parameters: [pathParam('ref', 'name@version', { type: 'string' })],
                get: {
                    summary: 'An annotation schema',
                    responses: { ...ok(ref('AnnotationSchema')), '404': errorResponse('Not found') },
                },
            },
            '/annotations': {
                get: {
                    summary: 'Feed of all (visible) annotations, oldest first',
                    parameters: queryParams(annotationFeedQuery, ['time_range']),
                    responses: ok(page('Annotation')),
                },
            },
            '/annotations/{annotation_id}': {
                parameters: [pathParam('annotation_id', 'Annotation id')],
                get: {
                    summary: 'An annotation',
                    responses: {
                        ...ok(ref('Annotation')),
                        '404': errorResponse('Not found (or not visible to you)'),
                        '410': errorResponse('Deleted'),
                    },
                },
                delete: { summary: 'Delete an annotation (creator only)', responses: noContent },
            },
            '/annotations/{annotation_id}/similar': {
                parameters: [pathParam('annotation_id', 'A vector annotation')],
                get: {
                    summary: 'The nearest annotations of the same (vector) schema',
                    description:
                        'By cosine distance, nearest first, using the schema\'s own vector index. The query annotation ' +
                        'is included (distance 0) unless exclude_same_sound is set. Each result includes enough of its ' +
                        'sound to label and play it.',
                    parameters: queryParams(similarQuery),
                    responses: {
                        ...ok({
                            type: 'object',
                            required: ['items'],
                            properties: {
                                items: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        required: ['distance', 'annotation', 'sound'],
                                        properties: {
                                            distance: { type: 'number' },
                                            annotation: ref('Annotation'),
                                            sound: {
                                                type: 'object',
                                                properties: {
                                                    id: { type: 'integer' },
                                                    title: { type: ['string', 'null'] },
                                                    audio_url: { type: 'string', format: 'uri' },
                                                    duration_seconds: { type: 'number' },
                                                    links: ref('Links'),
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        }),
                        '404': errorResponse('Not found (or not visible to you)'),
                        '410': errorResponse('Deleted'),
                    },
                },
            },
            '/blobs': {
                post: {
                    summary: 'Upload a binary payload (e.g. .npz features) for use in blob annotations',
                    requestBody: {
                        required: true,
                        content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
                    },
                    responses: created(ref('Blob')),
                },
            },
        },
    });
