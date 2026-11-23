import type { LicenseType } from '@cochlea/shared';
import type pg from 'pg';
import {
    executeCommand,
    executeQuery,
    executeQueryOne,
    isPgError,
    PG_UNIQUE_VIOLATION,
    withTransaction,
} from '../../shared/db/pool';
import { acquireFeedLock } from '../../shared/feed';
import type { SoundId, UserId } from '../../shared/ids';
import { DuplicateAudioUrl, type Sound, type SoundsPersistence } from '../domain';

interface SoundRow {
    id: number;
    created_at: Date;
    created_by: number;
    audio_url: string;
    info_url: string | null;
    low_quality_audio_url: string | null;
    license_type: LicenseType;
    title: string | null;
    duration_seconds: number;
    deleted_at: Date | null;
}

const COLUMNS = `id, created_at, created_by, audio_url, info_url, low_quality_audio_url,
                 license_type, title, duration_seconds, deleted_at`;

const toSound = (row: SoundRow): Sound => ({
    id: row.id as SoundId,
    createdAt: row.created_at,
    createdBy: row.created_by as UserId,
    audioUrl: row.audio_url,
    infoUrl: row.info_url,
    lowQualityAudioUrl: row.low_quality_audio_url,
    licenseType: row.license_type,
    title: row.title,
    durationSeconds: row.duration_seconds,
});

export const buildSoundsPersistence = (pool: pg.Pool): SoundsPersistence => ({
    async insert(createdBy, sound) {
        try {
            const row = await withTransaction(pool, async (tx) => {
                await acquireFeedLock(tx, 'sounds');
                return executeQueryOne<SoundRow>(
                    tx,
                    `insert into sounds (created_by, audio_url, info_url, low_quality_audio_url,
                                         license_type, title, duration_seconds)
                     values ($1, $2, $3, $4, $5, $6, $7)
                     returning ${COLUMNS}`,
                    [
                        createdBy,
                        sound.audioUrl,
                        sound.infoUrl,
                        sound.lowQualityAudioUrl,
                        sound.licenseType,
                        sound.title,
                        sound.durationSeconds,
                    ]
                );
            });
            return toSound(row!);
        } catch (err) {
            if (isPgError(err, PG_UNIQUE_VIOLATION) && err.constraint === 'sounds_audio_url_key') {
                const existing = await executeQueryOne<{ id: number }>(
                    pool,
                    'select id from sounds where audio_url = $1',
                    [sound.audioUrl]
                );
                throw new DuplicateAudioUrl(sound.audioUrl, existing!.id as SoundId);
            }
            throw err;
        }
    },

    async lookup(id) {
        const row = await executeQueryOne<SoundRow>(pool, `select ${COLUMNS} from sounds where id = $1`, [id]);
        if (!row) return { status: 'missing' };
        return { status: row.deleted_at ? 'deleted' : 'found', sound: toSound(row) };
    },

    async feed({ lowId, pageSize, createdBy }) {
        const rows = await executeQuery<SoundRow>(
            pool,
            `select ${COLUMNS} from sounds
             where deleted_at is null
               and id > $1
               and ($2::bigint is null or created_by = $2)
             order by id
             limit $3`,
            [lowId ?? 0, createdBy, pageSize + 1]
        );
        return { items: rows.slice(0, pageSize).map(toSound), hasMore: rows.length > pageSize };
    },

    async markDeleted(id, deletedBy) {
        await executeCommand(
            pool,
            'update sounds set deleted_at = now(), deleted_by = $2 where id = $1 and deleted_at is null',
            [id, deletedBy]
        );
    },
});
