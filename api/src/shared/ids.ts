import type {
    AnnotationId,
    AnnotationSchemaId,
    ApiKeyId,
    SoundId,
    UserId,
} from '@cochlea/shared';
import { InvalidRequest } from './errors';

export type { AnnotationId, AnnotationSchemaId, ApiKeyId, SoundId, UserId };

/**
 * Parse an untrusted value (path param, query string, database row) into a
 * branded integer id, or throw `InvalidRequest`.
 */
const intId =
    <T extends number>(label: string) =>
    (raw: unknown): T => {
        const n =
            typeof raw === 'number'
                ? raw
                : typeof raw === 'string' && /^\d+$/.test(raw)
                  ? Number(raw)
                  : NaN;
        if (!Number.isSafeInteger(n) || n < 1) {
            throw new InvalidRequest([`Invalid ${label}: ${String(raw)}`]);
        }
        return n as T;
    };

export const toUserId = intId<UserId>('user id');
export const toApiKeyId = intId<ApiKeyId>('api key id');
export const toSoundId = intId<SoundId>('sound id');
export const toAnnotationSchemaId = intId<AnnotationSchemaId>('annotation schema id');
export const toAnnotationId = intId<AnnotationId>('annotation id');
