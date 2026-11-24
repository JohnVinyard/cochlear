import type { LicenseType } from '@cochlea/shared';
import { type Principal, requireRole } from '../auth/domain';
import { Conflict, Gone, InvalidRequest, NotFound, PermissionDenied } from '../shared/errors';
import type { SoundFormatId, SoundId, UserId } from '../shared/ids';
import { type FeedPage, type FeedRequest } from '../shared/paging';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Sound {
    id: SoundId;
    createdAt: Date;
    createdBy: UserId;
    audioUrl: string;
    infoUrl: string | null;
    licenseType: LicenseType;
    title: string | null;
    durationSeconds: number;
    /** Its live (not deleted) encodings, oldest first */
    formats: SoundFormat[];
}

/**
 * An encoding of a sound: another file with the same audio. Immutable;
 * attributed (anyone with SOUND_EDITOR may add one, to any sound), and
 * soft-deleted by its creator, like annotations.
 */
export interface SoundFormat {
    id: SoundFormatId;
    soundId: SoundId;
    url: string;
    /** RFC 6838 type/subtype, lowercase, without parameters */
    mimeType: string;
    /** Unstructured, varying by type (docs/sound-formats.md) */
    metadata: Record<string, unknown>;
    createdBy: UserId;
    createdAt: Date;
}

export type NewSoundFormat = Pick<SoundFormat, 'url' | 'mimeType' | 'metadata'>;

export type NewSound = Omit<Sound, 'id' | 'createdAt' | 'createdBy' | 'formats'> & { formats: NewSoundFormat[] };

export const MAX_FORMATS_PER_REQUEST = 20;
/** Serialized metadata, in UTF-8 bytes */
export const MAX_FORMAT_METADATA_BYTES = 16 * 1024;
/** RFC 6838 restricted names, after lowercasing */
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

export type SoundFormatLookup =
    | { status: 'found' | 'deleted'; format: SoundFormat }
    | { status: 'missing' };

export interface SoundFeedRequest extends FeedRequest<SoundId> {
    createdBy: UserId | null;
}

export type SoundLookup =
    | { status: 'found'; sound: Sound }
    | { status: 'deleted'; sound: Sound }
    | { status: 'missing' };

// ---------------------------------------------------------------------------
// Outgoing ports
// ---------------------------------------------------------------------------

export interface SoundsPersistence {
    /** Throws `DuplicateAudioUrl` when `audio_url` is already registered */
    insert(createdBy: UserId, sound: NewSound): Promise<Sound>;
    lookup(id: SoundId): Promise<SoundLookup>;
    feed(request: SoundFeedRequest): Promise<FeedPage<Sound>>;
    markDeleted(id: SoundId, deletedBy: UserId): Promise<void>;
    /** Throws `DuplicateFormatUrl` when the sound already has a format at that URL */
    insertFormat(soundId: SoundId, createdBy: UserId, format: NewSoundFormat): Promise<SoundFormat>;
    lookupFormat(id: SoundFormatId): Promise<SoundFormatLookup>;
    markFormatDeleted(id: SoundFormatId, deletedBy: UserId): Promise<void>;
}

export class DuplicateFormatUrl extends Conflict {
    constructor(soundId: SoundId, url: string, existing: SoundFormatId) {
        super(`sound ${soundId} already has a format at ${url}`, `/sounds/${soundId}/formats/${existing}`);
    }
}

export class DuplicateAudioUrl extends Conflict {
    constructor(audioUrl: string, existing: SoundId) {
        super(`A sound with audio_url ${audioUrl} already exists`, `/sounds/${existing}`);
    }
}

// ---------------------------------------------------------------------------
// Incoming ports
// ---------------------------------------------------------------------------

export interface SoundsDomain {
    createSound(actor: Principal, sound: NewSound): Promise<Sound>;
    getSound(actor: Principal, id: SoundId): Promise<Sound>;
    listSounds(actor: Principal, request: SoundFeedRequest): Promise<FeedPage<Sound>>;
    deleteSound(actor: Principal, id: SoundId): Promise<void>;
    addFormat(actor: Principal, soundId: SoundId, format: NewSoundFormat): Promise<SoundFormat>;
    getFormat(actor: Principal, soundId: SoundId, id: SoundFormatId): Promise<SoundFormat>;
    deleteFormat(actor: Principal, soundId: SoundId, id: SoundFormatId): Promise<void>;
    /** Internal (no authorization), for use by other domains */
    lookupSound(id: SoundId): Promise<SoundLookup>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const isHttpUrl = (s: string): boolean => {
    try {
        const u = new URL(s);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
};

/** Validates a format, normalising its MIME type to lowercase */
export const validateFormat = (format: NewSoundFormat, label = 'format'): { format: NewSoundFormat; errors: string[] } => {
    const errors: string[] = [];
    const mimeType = format.mimeType.trim().toLowerCase();
    if (!isHttpUrl(format.url)) errors.push(`${label}: url must be an http(s) URL`);
    if (!MIME_TYPE.test(mimeType)) {
        errors.push(`${label}: mime_type must be a type/subtype, e.g. audio/mpeg (no parameters), not "${format.mimeType}"`);
    }
    const metadata = format.metadata;
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
        errors.push(`${label}: metadata must be a JSON object`);
    } else {
        const bytes = Buffer.byteLength(JSON.stringify(metadata), 'utf8');
        if (bytes > MAX_FORMAT_METADATA_BYTES) {
            errors.push(`${label}: metadata is ${bytes} bytes; the limit is ${MAX_FORMAT_METADATA_BYTES}`);
        }
    }
    return { format: { ...format, mimeType }, errors };
};

export const validateNewSound = (sound: NewSound): { sound: NewSound; errors: string[] } => {
    const errors: string[] = [];
    if (!isHttpUrl(sound.audioUrl)) errors.push('audio_url must be an http(s) URL');
    if (sound.infoUrl !== null && !isHttpUrl(sound.infoUrl)) errors.push('info_url must be an http(s) URL');
    if (!(sound.durationSeconds > 0) || !Number.isFinite(sound.durationSeconds)) {
        errors.push('duration_seconds must be a positive number');
    }
    if (sound.formats.length > MAX_FORMATS_PER_REQUEST) {
        errors.push(`at most ${MAX_FORMATS_PER_REQUEST} formats at a time`);
    }
    const formats = sound.formats.map((f, i) => {
        const checked = validateFormat(f, `formats[${i}]`);
        errors.push(...checked.errors);
        return checked.format;
    });
    const urls = formats.map((f) => f.url);
    if (new Set(urls).size !== urls.length) errors.push('formats must have different urls');
    return { sound: { ...sound, formats }, errors };
};

export const buildSoundsDomain = (persistence: SoundsPersistence): SoundsDomain => {
    const mustGet = async (id: SoundId): Promise<Sound> => {
        const result = await persistence.lookup(id);
        if (result.status === 'missing') throw new NotFound(`sound ${id}`);
        if (result.status === 'deleted') throw new Gone(`sound ${id}`);
        return result.sound;
    };

    /** A live format of a live sound; a format of another sound is missing, as far as this sound is concerned */
    const mustGetFormat = async (soundId: SoundId, id: SoundFormatId): Promise<SoundFormat> => {
        await mustGet(soundId);
        const result = await persistence.lookupFormat(id);
        if (result.status === 'missing' || result.format.soundId !== soundId) {
            throw new NotFound(`format ${id} of sound ${soundId}`);
        }
        if (result.status === 'deleted') throw new Gone(`format ${id} of sound ${soundId}`);
        return result.format;
    };

    return {
        async createSound(actor, input) {
            requireRole(actor, 'SOUND_EDITOR');
            const { sound, errors } = validateNewSound(input);
            if (errors.length) throw new InvalidRequest(errors);
            return persistence.insert(actor.user.id, sound);
        },

        async addFormat(actor, soundId, input) {
            requireRole(actor, 'SOUND_EDITOR');
            await mustGet(soundId);
            const { format, errors } = validateFormat(input);
            if (errors.length) throw new InvalidRequest(errors);
            return persistence.insertFormat(soundId, actor.user.id, format);
        },

        async getFormat(actor, soundId, id) {
            requireRole(actor, 'SOUND_READER');
            return mustGetFormat(soundId, id);
        },

        async deleteFormat(actor, soundId, id) {
            requireRole(actor, 'SOUND_EDITOR');
            const format = await mustGetFormat(soundId, id);
            if (format.createdBy !== actor.user.id) {
                throw new PermissionDenied('only the creator of a format may delete it');
            }
            await persistence.markFormatDeleted(id, actor.user.id);
        },

        async getSound(actor, id) {
            requireRole(actor, 'SOUND_READER');
            return mustGet(id);
        },

        async listSounds(actor, request) {
            requireRole(actor, 'SOUND_READER');
            return persistence.feed(request);
        },

        async deleteSound(actor, id) {
            requireRole(actor, 'SOUND_EDITOR');
            const sound = await mustGet(id);
            if (sound.createdBy !== actor.user.id) {
                throw new PermissionDenied('only the creator of a sound may delete it');
            }
            await persistence.markDeleted(id, actor.user.id);
        },

        lookupSound: (id) => persistence.lookup(id),
    };
};
