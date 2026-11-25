import type { AnnotationKind, SchemaRef } from '@cochlea/shared';
import { hasRole, type Principal, requireRole } from '../auth/domain';
import { InvalidRequest, NotFound, PermissionDenied } from '../shared/errors';
import type { AnnotationSchemaId, UserId } from '../shared/ids';
import type { FeedPage, FeedRequest } from '../shared/paging';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Describes one type of annotation.  The `kind` decides which value an
 * annotation carries (and therefore which column / index it lands in);  the
 * optional `jsonSchema` additionally constrains an annotation's free-form
 * `data`.  Schemas are immutable;  publishing under an existing name
 * creates the next version.
 */
export interface AnnotationSchema {
    id: AnnotationSchemaId;
    name: string;
    version: number;
    kind: AnnotationKind;
    vectorDim: number | null;
    jsonSchema: object | null;
    description: string;
    createdAt: Date;
    createdBy: UserId;
    /** Public, live annotations of this schema (private ones aren't counted, so as not to reveal them) */
    annotationCount: number;
}

export interface NewAnnotationSchema {
    name: string;
    kind: AnnotationKind;
    vectorDim: number | null;
    jsonSchema: object | null;
    description: string;
}

export const schemaRef = (s: Pick<AnnotationSchema, 'name' | 'version'>): SchemaRef => `${s.name}@${s.version}`;

export const SCHEMA_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SCHEMA_REF_PATTERN = /^([a-z0-9][a-z0-9-]{0,63})@([1-9][0-9]*)$/;
/**
 * pgvector can only build HNSW/IVFFlat indices on `vector`s of at most 2000
 * dimensions.  Larger embeddings should be truncated (e.g. matryoshka).
 */
export const MAX_VECTOR_DIM = 2000;

export const parseSchemaRef = (ref: string): { name: string; version: number } => {
    const match = SCHEMA_REF_PATTERN.exec(ref);
    if (!match) throw new InvalidRequest([`invalid schema reference "${ref}"; expected name@version`]);
    return { name: match[1]!, version: Number(match[2]) };
};

// ---------------------------------------------------------------------------
// Outgoing ports
// ---------------------------------------------------------------------------

export interface AnnotationSchemasPersistence {
    /** Inserts the next version for `schema.name`, provided the latest is owned by `createdBy` (or none exists) */
    insertNextVersion(
        createdBy: UserId,
        schema: NewAnnotationSchema
    ): Promise<{ status: 'created'; schema: AnnotationSchema } | { status: 'notOwner' }>;
    getByRef(name: string, version: number): Promise<AnnotationSchema | null>;
    getByRefs(refs: { name: string; version: number }[]): Promise<AnnotationSchema[]>;
    getById(id: AnnotationSchemaId): Promise<AnnotationSchema | null>;
    feed(request: FeedRequest<AnnotationSchemaId>): Promise<FeedPage<AnnotationSchema>>;
    vectorSchemas(): Promise<AnnotationSchema[]>;
    /** Creates the schema's vector index (see shared/db/vectors.ts) if it's missing or broken */
    ensureVectorIndex(schema: AnnotationSchema): Promise<'exists' | 'created'>;
    /**
     * ensureVectorIndex, in the background: building one scans the whole
     * annotations table, which takes a while once it's big. Failures are
     * logged; ensureVectorIndexes at startup retries them.
     */
    scheduleVectorIndex(schema: AnnotationSchema): void;
}

/** Checks that a JSON schema is itself valid;  returns error messages */
export type JsonSchemaChecker = (schema: object) => string[];

// ---------------------------------------------------------------------------
// Incoming ports
// ---------------------------------------------------------------------------

export interface AnnotationSchemasDomain {
    createSchema(actor: Principal, schema: NewAnnotationSchema): Promise<AnnotationSchema>;
    getSchema(actor: Principal, ref: string): Promise<AnnotationSchema>;
    listSchemas(actor: Principal, request: FeedRequest<AnnotationSchemaId>): Promise<FeedPage<AnnotationSchema>>;
    /**
     * Internal (no authorization):  resolves refs for other domains,
     * throwing `InvalidRequest` for any unknown schema
     */
    resolveRefs(refs: readonly string[]): Promise<Map<string, AnnotationSchema>>;
    /** Internal (no authorization) */
    getById(id: AnnotationSchemaId): Promise<AnnotationSchema | null>;
    /**
     * Internal: makes sure every vector schema has its search index (they're
     * created along with the schema; this catches older schemas, and indices
     * whose build was interrupted). Returns the refs of the ones it created.
     */
    ensureVectorIndexes(): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Policy: who may do what. The use cases enforce it; the HTTP adapter offers
// a link for an action only when it allows it.
// ---------------------------------------------------------------------------

export const annotationSchemaPolicy = {
    read: (actor: Principal) => hasRole(actor, 'ANNOTATION_SCHEMA_READER'),
    /** A new schema, or the next version of one you own (which only the database can tell) */
    create: (actor: Principal) => hasRole(actor, 'ANNOTATION_SCHEMA_CREATOR'),
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export const buildAnnotationSchemasDomain = (
    persistence: AnnotationSchemasPersistence,
    checkJsonSchema: JsonSchemaChecker
): AnnotationSchemasDomain => ({
    async createSchema(actor, schema) {
        requireRole(actor, 'ANNOTATION_SCHEMA_CREATOR');
        const errors: string[] = [];
        if (!SCHEMA_NAME_PATTERN.test(schema.name)) {
            errors.push('name must be 1-64 lowercase letters, digits or "-", starting with a letter or digit');
        }
        if (schema.kind === 'vector') {
            if (schema.vectorDim === null || !Number.isInteger(schema.vectorDim) || schema.vectorDim < 1 || schema.vectorDim > MAX_VECTOR_DIM) {
                errors.push(`vector schemas require an integer vector_dim between 1 and ${MAX_VECTOR_DIM}`);
            }
        } else if (schema.vectorDim !== null) {
            errors.push('vector_dim is only allowed for vector schemas');
        }
        if (schema.jsonSchema !== null) {
            errors.push(...checkJsonSchema(schema.jsonSchema));
        }
        if (errors.length) throw new InvalidRequest(errors);

        const result = await persistence.insertNextVersion(actor.user.id, schema);
        if (result.status === 'notOwner') {
            throw new PermissionDenied(`only the owner of schema "${schema.name}" may publish new versions`);
        }
        // every vector schema is searchable: it gets its own index. Until that's built,
        // searches still work (by sequential scan), just more slowly.
        if (result.schema.kind === 'vector') persistence.scheduleVectorIndex(result.schema);
        return result.schema;
    },

    async getSchema(actor, ref) {
        requireRole(actor, 'ANNOTATION_SCHEMA_READER');
        const { name, version } = parseSchemaRef(ref);
        const schema = await persistence.getByRef(name, version);
        if (!schema) throw new NotFound(`annotation schema ${ref}`);
        return schema;
    },

    async listSchemas(actor, request) {
        requireRole(actor, 'ANNOTATION_SCHEMA_READER');
        return persistence.feed(request);
    },

    async resolveRefs(refs) {
        const unique = [...new Set(refs)];
        const parsed = unique.map(parseSchemaRef);
        const found = await persistence.getByRefs(parsed);
        const byRef = new Map(found.map((s) => [schemaRef(s) as string, s]));
        const unknown = unique.filter((r) => !byRef.has(r));
        if (unknown.length) throw new InvalidRequest([`unknown annotation schema(s): ${unknown.join(', ')}`]);
        return byRef;
    },

    getById: (id) => persistence.getById(id),

    async ensureVectorIndexes() {
        const created: string[] = [];
        for (const schema of await persistence.vectorSchemas()) {
            if ((await persistence.ensureVectorIndex(schema)) === 'created') created.push(schemaRef(schema));
        }
        return created;
    },
});
