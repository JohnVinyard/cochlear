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
import type { SoundFormatId, SoundId, UserId } from '../../shared/ids';
import {
    DuplicateAudioUrl,
    DuplicateFormatUrl,
    type NewSoundFormat,
    type Sound,
    type SoundFormat,
    type SoundsPersistence,
} from '../domain';

interface SoundRow {
    id: number;
    created_at: Date;
    created_by: number;
    audio_url: string;
    info_url: string | null;
    license_type: LicenseType;
    title: string | null;
    duration_seconds: number;
    deleted_at: Date | null;
}

interface FormatRow {
    id: number;
    sound_id: number;
    url: string;
    mime_type: string;
    metadata: Record<string, unknown>;
    created_by: number;
    created_at: Date;
    deleted_at: Date | null;
}

const COLUMNS = `id, created_at, created_by, audio_url, info_url, license_type, title, duration_seconds, deleted_at`;
const FORMAT_COLUMNS = `id, sound_id, url, mime_type, metadata, created_by, created_at, deleted_at`;

const toFormat = (row: FormatRow): SoundFormat => ({
    id: row.id as SoundFormatId,
    soundId: row.sound_id as SoundId,
    url: row.url,
    mimeType: row.mime_type,
    metadata: row.metadata,
    createdBy: row.created_by as UserId,
    createdAt: row.created_at,
});

const toSound = (row: SoundRow, formats: SoundFormat[]): Sound => ({
    id: row.id as SoundId,
    createdAt: row.created_at,
    createdBy: row.created_by as UserId,
    audioUrl: row.audio_url,
    infoUrl: row.info_url,
    licenseType: row.license_type,
    title: row.title,
    durationSeconds: row.duration_seconds,
    formats,
});

const FORMAT_URL_KEY = 'sound_formats_url_key';

export const buildSoundsPersistence = (pool: pg.Pool): SoundsPersistence => {
    /** Live formats of these sounds, by sound id, oldest first */
    const formatsOf = async (db: pg.Pool | pg.PoolClient, soundIds: number[]): Promise<Map<number, SoundFormat[]>> => {
        const byId = new Map<number, SoundFormat[]>(soundIds.map((id) => [id, []]));
        if (!soundIds.length) return byId;
        const rows = await executeQuery<FormatRow>(
            db,
            `select ${FORMAT_COLUMNS} from sound_formats
             where sound_id = any($1::bigint[]) and deleted_at is null
             order by sound_id, id`,
            [soundIds]
        );
        for (const row of rows) byId.get(row.sound_id)!.push(toFormat(row));
        return byId;
    };

    const insertFormat = (db: pg.PoolClient, soundId: number, createdBy: UserId, f: NewSoundFormat) =>
        executeQueryOne<FormatRow>(
            db,
            `insert into sound_formats (sound_id, url, mime_type, metadata, created_by)
             values ($1, $2, $3, $4, $5)
             returning ${FORMAT_COLUMNS}`,
            [soundId, f.url, f.mimeType, JSON.stringify(f.metadata), createdBy]
        );

    return {
        async insert(createdBy, sound) {
            try {
                const created = await withTransaction(pool, async (tx) => {
                    await acquireFeedLock(tx, 'sounds');
                    const row = await executeQueryOne<SoundRow>(
                        tx,
                        `insert into sounds (created_by, audio_url, info_url, license_type, title, duration_seconds)
                         values ($1, $2, $3, $4, $5, $6)
                         returning ${COLUMNS}`,
                        [createdBy, sound.audioUrl, sound.infoUrl, sound.licenseType, sound.title, sound.durationSeconds]
                    );
                    const formats: SoundFormat[] = [];
                    for (const f of sound.formats) formats.push(toFormat((await insertFormat(tx, row!.id, createdBy, f))!));
                    return toSound(row!, formats);
                });
                return created;
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
            const formats = (await formatsOf(pool, [row.id])).get(row.id)!;
            return { status: row.deleted_at ? 'deleted' : 'found', sound: toSound(row, formats) };
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
            const page = rows.slice(0, pageSize);
            const formats = await formatsOf(pool, page.map((r) => r.id));
            return { items: page.map((r) => toSound(r, formats.get(r.id)!)), hasMore: rows.length > pageSize };
        },

        async markDeleted(id, deletedBy) {
            await executeCommand(
                pool,
                'update sounds set deleted_at = now(), deleted_by = $2 where id = $1 and deleted_at is null',
                [id, deletedBy]
            );
        },

        async insertFormat(soundId, createdBy, format) {
            try {
                return toFormat((await withTransaction(pool, (tx) => insertFormat(tx, soundId, createdBy, format)))!);
            } catch (err) {
                if (isPgError(err, PG_UNIQUE_VIOLATION) && err.constraint === FORMAT_URL_KEY) {
                    const existing = await executeQueryOne<{ id: number }>(
                        pool,
                        'select id from sound_formats where sound_id = $1 and url = $2 and deleted_at is null',
                        [soundId, format.url]
                    );
                    throw new DuplicateFormatUrl(soundId, format.url, existing!.id as SoundFormatId);
                }
                throw err;
            }
        },

        async lookupFormat(id) {
            const row = await executeQueryOne<FormatRow>(pool, `select ${FORMAT_COLUMNS} from sound_formats where id = $1`, [
                id,
            ]);
            if (!row) return { status: 'missing' };
            return { status: row.deleted_at ? 'deleted' : 'found', format: toFormat(row) };
        },

        async markFormatDeleted(id, deletedBy) {
            await executeCommand(
                pool,
                'update sound_formats set deleted_at = now(), deleted_by = $2 where id = $1 and deleted_at is null',
                [id, deletedBy]
            );
        },
    };
};
