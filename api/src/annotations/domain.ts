import type { AnnotationKind, SchemaRef } from '@cochlea/shared';
import type { AnnotationSchema, AnnotationSchemasDomain } from '../annotationSchemas/domain';
import { schemaRef } from '../annotationSchemas/domain';
import { type Principal, requireRole } from '../auth/domain';
import { Gone, InvalidRequest, NotFound, PermissionDenied } from '../shared/errors';
import type { AnnotationId, AnnotationSchemaId, SoundId, UserId } from '../shared/ids';
import type { FeedPage, FeedRequest } from '../shared/paging';
import type { SoundsDomain } from '../sounds/domain';
import type { UsersDomain } from '../users/domain';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Who may see an annotation (besides its creator, who always can) */
export type Access =
    | { type: 'private' }
    | { type: 'public' }
    | { type: 'users'; userIds: UserId[] };

/** Exactly one value, determined by the schema's kind */
export type AnnotationValue =
    | { kind: 'tags'; tags: string[] }
    | { kind: 'text'; text: string }
    | { kind: 'vector'; vector: number[] }
    | { kind: 'kv'; kv: Record<string, unknown> }
    | { kind: 'blob'; blob: { url: string; contentType: string } };

/** A time slice of a sound;  `null` means the annotation describes the whole sound */
export interface Segment {
    startSeconds: number;
    durationSeconds: number;
}

export interface Annotation {
    id: AnnotationId;
    soundId: SoundId;
    schemaId: AnnotationSchemaId;
    schemaRef: SchemaRef;
    createdBy: UserId;
    createdAt: Date;
    segment: Segment | null;
    value: AnnotationValue;
    data: unknown;
    access: Access;
}

/** An annotation that passed validation and is ready to be stored */
export type ValidAnnotation = Omit<Annotation, 'id' | 'createdAt' | 'createdBy' | 'soundId'>;

/** Untrusted input, already structurally validated by the API adapter */
export interface AnnotationInput {
    schema: string;
    startSeconds?: number;
    durationSeconds?: number;
    tags?: string[];
    text?: string;
    vector?: number[];
    kv?: Record<string, unknown>;
    blob?: { url: string; contentType: string };
    data?: unknown;
    access: Access;
}

export interface AnnotationFeedRequest extends FeedRequest<AnnotationId> {
    soundId: SoundId | null;
    createdBy: UserId | null;
    schema: string | null;
    tags: string[] | null;
    /** Only annotations overlapping this range (plus whole-sound annotations) */
    timeRange: { start: number; end: number } | null;
}

export type AnnotationLookup =
    | { status: 'found' | 'deleted'; annotation: Annotation; visible: boolean }
    | { status: 'missing' };

export const MAX_BATCH_SIZE = 500;
export const MAX_TAG_LENGTH = 256;
/** Tolerance when checking that a segment fits within its sound */
const DURATION_EPSILON_SECONDS = 1e-3;

// ---------------------------------------------------------------------------
// Outgoing ports
// ---------------------------------------------------------------------------

export interface AnnotationsPersistence {
    /** Atomically inserts all annotations, in order */
    insertBatch(createdBy: UserId, soundId: SoundId, annotations: ValidAnnotation[]): Promise<Annotation[]>;
    lookup(id: AnnotationId, viewer: UserId): Promise<AnnotationLookup>;
    feed(
        viewer: UserId,
        request: Omit<AnnotationFeedRequest, 'schema'> & { schemaId: AnnotationSchemaId | null }
    ): Promise<FeedPage<Annotation>>;
    markDeleted(id: AnnotationId, deletedBy: UserId): Promise<void>;
}

/** Validates `data` against a JSON schema;  returns error messages */
export type JsonValidator = (schema: object, data: unknown) => string[];

// ---------------------------------------------------------------------------
// Incoming ports
// ---------------------------------------------------------------------------

export interface AnnotationsDomain {
    createAnnotations(actor: Principal, soundId: SoundId, inputs: AnnotationInput[]): Promise<Annotation[]>;
    getAnnotation(actor: Principal, id: AnnotationId): Promise<Annotation>;
    listAnnotations(actor: Principal, request: AnnotationFeedRequest): Promise<FeedPage<Annotation>>;
    deleteAnnotation(actor: Principal, id: AnnotationId): Promise<void>;
}

// ---------------------------------------------------------------------------
// Validation (pure)
// ---------------------------------------------------------------------------

const VALUE_FIELDS = ['tags', 'text', 'vector', 'kv', 'blob'] as const satisfies readonly AnnotationKind[];

const isHttpUrl = (s: string): boolean => {
    try {
        const u = new URL(s);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
};

export const validateSegment = (
    input: Pick<AnnotationInput, 'startSeconds' | 'durationSeconds'>,
    soundDurationSeconds: number
): { segment: Segment | null; errors: string[] } => {
    const { startSeconds: start, durationSeconds: duration } = input;
    if (start === undefined && duration === undefined) return { segment: null, errors: [] };
    if (start === undefined || duration === undefined) {
        return { segment: null, errors: ['start_seconds and duration_seconds must be supplied together'] };
    }
    const errors: string[] = [];
    if (!Number.isFinite(start) || start < 0) errors.push('start_seconds must be >= 0');
    if (!Number.isFinite(duration) || duration < 0) errors.push('duration_seconds must be >= 0');
    if (!errors.length && start + duration > soundDurationSeconds + DURATION_EPSILON_SECONDS) {
        errors.push(`segment ends at ${start + duration}s, after the end of the sound (${soundDurationSeconds}s)`);
    }
    return { segment: errors.length ? null : { startSeconds: start, durationSeconds: duration }, errors };
};

export const validateValue = (
    input: AnnotationInput,
    schema: AnnotationSchema
): { value: AnnotationValue | null; errors: string[] } => {
    const supplied = VALUE_FIELDS.filter((f) => input[f] !== undefined);
    const extra = supplied.filter((f) => f !== schema.kind);
    const errors: string[] = extra.length
        ? [`schema ${schemaRef(schema)} is of kind "${schema.kind}"; unexpected field(s): ${extra.join(', ')}`]
        : [];

    const fail = (message: string) => ({ value: null, errors: [...errors, message] });
    const ok = (value: AnnotationValue) => ({ value: errors.length ? null : value, errors });

    switch (schema.kind) {
        case 'tags': {
            const tags = input.tags;
            if (!tags?.length) return fail('tags must be a non-empty array');
            if (tags.some((t) => !t.trim() || t.length > MAX_TAG_LENGTH)) {
                return fail(`each tag must be 1-${MAX_TAG_LENGTH} non-blank characters`);
            }
            return ok({ kind: 'tags', tags: [...new Set(tags.map((t) => t.trim()))] });
        }
        case 'text': {
            if (!input.text?.trim()) return fail('text must be a non-empty string');
            return ok({ kind: 'text', text: input.text });
        }
        case 'vector': {
            const v = input.vector;
            if (!v) return fail('vector is required');
            if (v.length !== schema.vectorDim) {
                return fail(`vector must have exactly ${schema.vectorDim} elements (got ${v.length})`);
            }
            if (v.some((x) => !Number.isFinite(x))) return fail('vector elements must be finite numbers');
            return ok({ kind: 'vector', vector: v });
        }
        case 'kv': {
            if (!input.kv || typeof input.kv !== 'object' || Array.isArray(input.kv)) {
                return fail('kv must be an object');
            }
            return ok({ kind: 'kv', kv: input.kv });
        }
        case 'blob': {
            if (!input.blob) return fail('blob is required');
            if (!isHttpUrl(input.blob.url)) return fail('blob.url must be an http(s) URL');
            return ok({ kind: 'blob', blob: input.blob });
        }
    }
};

export const normalizeAccess = (access: Access, creator: UserId): Access =>
    access.type === 'users'
        ? { type: 'users', userIds: [...new Set(access.userIds)].filter((id) => id !== creator) }
        : access;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export const buildAnnotationsDomain = (
    persistence: AnnotationsPersistence,
    deps: {
        schemas: Pick<AnnotationSchemasDomain, 'resolveRefs'>;
        sounds: Pick<SoundsDomain, 'lookupSound'>;
        users: Pick<UsersDomain, 'requireUsersExist'>;
        validateJson: JsonValidator;
    }
): AnnotationsDomain => {
    const mustBeVisible = async (actor: Principal, id: AnnotationId): Promise<Annotation> => {
        const result = await persistence.lookup(id, actor.user.id);
        // don't reveal the existence of annotations the actor can't see
        if (result.status === 'missing' || !result.visible) throw new NotFound(`annotation ${id}`);
        if (result.status === 'deleted') throw new Gone(`annotation ${id}`);
        return result.annotation;
    };

    return {
        async createAnnotations(actor, soundId, inputs) {
            requireRole(actor, 'ANNOTATION_EDITOR');
            if (!inputs.length || inputs.length > MAX_BATCH_SIZE) {
                throw new InvalidRequest([`between 1 and ${MAX_BATCH_SIZE} annotations may be created at once`]);
            }

            const sound = await deps.sounds.lookupSound(soundId);
            if (sound.status === 'missing') throw new NotFound(`sound ${soundId}`);
            if (sound.status === 'deleted') throw new Gone(`sound ${soundId}`);

            const schemas = await deps.schemas.resolveRefs(inputs.map((i) => i.schema));

            const errors: string[] = [];
            const valid: ValidAnnotation[] = [];
            inputs.forEach((input, i) => {
                const schema = schemas.get(input.schema)!;
                const segment = validateSegment(input, sound.sound.durationSeconds);
                const value = validateValue(input, schema);
                const dataErrors = schema.jsonSchema ? deps.validateJson(schema.jsonSchema, input.data ?? null) : [];
                const itemErrors = [...segment.errors, ...value.errors, ...dataErrors];
                if (itemErrors.length) {
                    errors.push(...itemErrors.map((e) => `annotations[${i}]: ${e}`));
                    return;
                }
                valid.push({
                    schemaId: schema.id,
                    schemaRef: schemaRef(schema),
                    segment: segment.segment,
                    value: value.value!,
                    data: input.data ?? null,
                    access: normalizeAccess(input.access, actor.user.id),
                });
            });
            if (errors.length) throw new InvalidRequest(errors);

            const grantees = valid.flatMap((a) => (a.access.type === 'users' ? a.access.userIds : []));
            await deps.users.requireUsersExist(grantees);

            return persistence.insertBatch(actor.user.id, soundId, valid);
        },

        async getAnnotation(actor, id) {
            requireRole(actor, 'ANNOTATION_READER');
            return mustBeVisible(actor, id);
        },

        async listAnnotations(actor, request) {
            requireRole(actor, 'ANNOTATION_READER');
            if (request.soundId !== null) {
                const sound = await deps.sounds.lookupSound(request.soundId);
                if (sound.status === 'missing') throw new NotFound(`sound ${request.soundId}`);
                if (sound.status === 'deleted') throw new Gone(`sound ${request.soundId}`);
            }
            if (request.timeRange && request.timeRange.end < request.timeRange.start) {
                throw new InvalidRequest(['time_range end must be >= start']);
            }
            const schemaId = request.schema
                ? (await deps.schemas.resolveRefs([request.schema])).get(request.schema)!.id
                : null;
            const { schema: _schema, ...rest } = request;
            return persistence.feed(actor.user.id, { ...rest, schemaId });
        },

        async deleteAnnotation(actor, id) {
            requireRole(actor, 'ANNOTATION_EDITOR');
            const annotation = await mustBeVisible(actor, id);
            if (annotation.createdBy !== actor.user.id) {
                throw new PermissionDenied('only the creator of an annotation may delete it');
            }
            await persistence.markDeleted(id, actor.user.id);
        },
    };
};
