import type { LicenseType } from '@cochlea/shared';
import { type Principal, requireRole } from '../auth/domain';
import { Conflict, Gone, InvalidRequest, NotFound, PermissionDenied } from '../shared/errors';
import type { SoundId, UserId } from '../shared/ids';
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
    lowQualityAudioUrl: string | null;
    licenseType: LicenseType;
    title: string | null;
    durationSeconds: number;
}

export type NewSound = Omit<Sound, 'id' | 'createdAt' | 'createdBy'>;

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

export const validateNewSound = (sound: NewSound): string[] => {
    const errors: string[] = [];
    if (!isHttpUrl(sound.audioUrl)) errors.push('audio_url must be an http(s) URL');
    if (sound.infoUrl !== null && !isHttpUrl(sound.infoUrl)) errors.push('info_url must be an http(s) URL');
    if (sound.lowQualityAudioUrl !== null && !isHttpUrl(sound.lowQualityAudioUrl)) {
        errors.push('low_quality_audio_url must be an http(s) URL');
    }
    if (!(sound.durationSeconds > 0) || !Number.isFinite(sound.durationSeconds)) {
        errors.push('duration_seconds must be a positive number');
    }
    return errors;
};

export const buildSoundsDomain = (persistence: SoundsPersistence): SoundsDomain => {
    const mustGet = async (id: SoundId): Promise<Sound> => {
        const result = await persistence.lookup(id);
        if (result.status === 'missing') throw new NotFound(`sound ${id}`);
        if (result.status === 'deleted') throw new Gone(`sound ${id}`);
        return result.sound;
    };

    return {
        async createSound(actor, sound) {
            requireRole(actor, 'SOUND_EDITOR');
            const errors = validateNewSound(sound);
            if (errors.length) throw new InvalidRequest(errors);
            return persistence.insert(actor.user.id, sound);
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
