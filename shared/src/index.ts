/**
 * Types and constants shared by the API server, the web app and (by
 * convention) the Python client.  Nothing in here may have runtime
 * dependencies.
 */

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

declare const brand: unique symbol;

/**
 * A nominal type: `Brand<number, 'UserId'>` is not assignable to
 * `Brand<number, 'SoundId'>`, or from a plain `number`.
 */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type UserId = Brand<number, 'UserId'>;
export type ApiKeyId = Brand<number, 'ApiKeyId'>;
export type SoundId = Brand<number, 'SoundId'>;
export type AnnotationSchemaId = Brand<number, 'AnnotationSchemaId'>;
export type AnnotationId = Brand<number, 'AnnotationId'>;
export type SoundFormatId = Brand<number, 'SoundFormatId'>;

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const ROLES = [
    'SOUND_READER',
    'ANNOTATION_READER',
    'ANNOTATION_SCHEMA_READER',
    'SOUND_EDITOR',
    'ANNOTATION_EDITOR',
    'ANNOTATION_SCHEMA_CREATOR',
    'API_KEY_CREATOR',
] as const;

export type Role = (typeof ROLES)[number];

export const isRole = (x: unknown): x is Role =>
    typeof x === 'string' && (ROLES as readonly string[]).includes(x);

/**
 * Roles granted to every user the first time they authenticate via firebase.
 */
export const DEFAULT_USER_ROLES: readonly Role[] = [
    'SOUND_READER',
    'ANNOTATION_READER',
    'ANNOTATION_SCHEMA_READER',
    'SOUND_EDITOR',
    'ANNOTATION_EDITOR',
    'API_KEY_CREATOR',
];

/**
 * `API_KEY_CREATOR` may never be granted to an API key;  API keys can only be
 * managed from the web (firebase) context.
 */
export const API_KEY_GRANTABLE_ROLES: readonly Role[] = ROLES.filter(
    (r) => r !== 'API_KEY_CREATOR'
);

export const API_KEY_PREFIX = 'cka_';

// ---------------------------------------------------------------------------
// Annotation schemas
// ---------------------------------------------------------------------------

export const ANNOTATION_KINDS = ['tags', 'text', 'vector', 'kv', 'blob'] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

/** `name@version`, e.g. `tags@1` */
export type SchemaRef = `${string}@${number}`;

export const LICENSE_TYPES = [
    'https://creativecommons.org/licenses/by/4.0',
    'https://creativecommons.org/licenses/by-sa/4.0',
    'https://creativecommons.org/licenses/by-nd/4.0',
    'https://creativecommons.org/licenses/by-nc/4.0',
    'https://creativecommons.org/licenses/by-nc-sa/4.0',
    'https://creativecommons.org/licenses/by-nc-nd/4.0',
    'https://creativecommons.org/publicdomain/zero/1.0',
] as const;
export type LicenseType = (typeof LICENSE_TYPES)[number];

// ---------------------------------------------------------------------------
// API resource representations (wire format, snake_case)
// ---------------------------------------------------------------------------

export type Links = Record<string, string>;

export interface Page<T> {
    items: T[];
    /** Absolute URL of the next page; absent when there are no more items (yet) */
    next?: string;
    links: Links;
}

export interface UserResource {
    id: UserId;
    user_name: string;
    about_me: string;
    info_url: string | null;
    created_at: string;
    /** Only present when viewing yourself */
    email?: string | null;
    roles?: Role[];
    links: Links;
}

export interface ApiKeyResource {
    id: ApiKeyId;
    name: string;
    prefix: string;
    roles: Role[];
    created_at: string;
    links: Links;
}

export interface CreatedApiKeyResource extends ApiKeyResource {
    /** Only ever returned once, at creation time */
    secret: string;
}

export interface SoundResource {
    id: SoundId;
    created_at: string;
    created_by: UserId;
    audio_url: string;
    info_url: string | null;
    license_type: LicenseType;
    title: string | null;
    duration_seconds: number;
    /** Other encodings of the same audio (see docs/sound-formats.md) */
    formats: SoundFormatResource[];
    links: Links;
}

/** An encoding of a sound: a file, its media type, and metadata that varies by type */
export interface SoundFormatResource {
    id: SoundFormatId;
    sound_id: SoundId;
    url: string;
    /** e.g. audio/mpeg, audio/wav, audio/vnd.cochlea.sprs+json */
    mime_type: string;
    /** Unstructured; suggested keys per type in docs/sound-formats.md (sample_rate, channels, bit_depth...) */
    metadata: Record<string, unknown>;
    created_by: UserId;
    created_at: string;
    links: Links;
}

/** The media type of documents in the cochlea codec (codec/SPEC.md) */
export const SPRS_MIME_TYPE = 'audio/vnd.cochlea.sprs+json';

export interface AnnotationSchemaResource {
    id: AnnotationSchemaId;
    name: string;
    version: number;
    ref: SchemaRef;
    kind: AnnotationKind;
    vector_dim: number | null;
    json_schema: object | null;
    description: string;
    created_at: string;
    created_by: UserId;
    links: Links;
}

/** `null` means private, `"*"` means any authenticated user */
export type Access = null | '*' | UserId[];

export interface BlobRef {
    url: string;
    content_type: string;
}

/** GET /annotations/{id}/similar */
export interface SimilarAnnotationsResource {
    items: {
        /** Cosine distance to the query annotation's vector: 0 is identical */
        distance: number;
        annotation: AnnotationResource;
        /** Enough of the annotation's sound to label and play it */
        sound: { id: number; title: string | null; audio_url: string; duration_seconds: number; links: Links };
    }[];
}

export interface AnnotationResource {
    id: AnnotationId;
    created_at: string;
    created_by: UserId;
    sound_id: SoundId;
    schema: SchemaRef;
    kind: AnnotationKind;
    start_seconds: number | null;
    duration_seconds: number | null;
    end_seconds: number | null;
    tags?: string[];
    text?: string;
    vector?: number[];
    kv?: Record<string, unknown>;
    blob?: BlobRef;
    data: unknown;
    /** Only shown to the annotation's creator */
    access?: Access;
    links: Links;
}

export interface NewAnnotation {
    schema: SchemaRef;
    start_seconds?: number;
    duration_seconds?: number;
    tags?: string[];
    text?: string;
    vector?: number[];
    kv?: Record<string, unknown>;
    blob?: BlobRef;
    data?: unknown;
    access: Access;
}

export interface ErrorBody {
    errors: string[];
}

/**
 * A convention, not an API rule: a blob annotation whose blob is an `.npz`
 * holding a time series (e.g. frame-level features) says how to read it in
 * `data.timeseries`, so viewers can draw it without knowing the schema.
 * Time is the **last** axis: 1-d arrays are `(frames,)`, 2-d ones
 * `(rows, frames)`. See docs/annotation-conventions.md.
 */
export interface TimeseriesData {
    /** Which array in the .npz; may be omitted if there's only one */
    array?: string;
    /** Frames per second: frame i is at start_seconds + i / frame_rate */
    frame_rate: number;
    /** When frame 0 is, relative to the annotation's start (or the sound's, for whole-sound annotations). Default 0. */
    start_seconds?: number;
    /** Labels for the rows of a 2-d array, first row first */
    rows?: string[];
    /** Display range [min, max]; default: the data's own */
    range?: [number, number];
    /** "global" (default): one colour scale for everything; "rows": each row scaled on its own */
    normalize?: 'global' | 'rows';
}

/** `data.timeseries`, if an annotation follows the time series convention */
export const timeseriesOf = (annotation: { blob?: BlobRef; data: unknown }): TimeseriesData | null => {
    const t = (annotation.data as { timeseries?: unknown } | null)?.timeseries as TimeseriesData | undefined;
    if (!annotation.blob || !t || typeof t !== 'object' || !(typeof t.frame_rate === 'number' && t.frame_rate > 0)) {
        return null;
    }
    return t;
};
