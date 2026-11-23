import type { AnnotationKind, SchemaRef } from '@cochlea/shared';
import type pg from 'pg';
import { executeCommand, executeQuery, executeQueryOne, withTransaction } from '../../shared/db/pool';
import { acquireFeedLock } from '../../shared/feed';
import type { AnnotationId, AnnotationSchemaId, SoundId, UserId } from '../../shared/ids';
import type { Access, Annotation, AnnotationsPersistence, AnnotationValue } from '../domain';

interface AnnotationRow {
    id: number;
    sound_id: number;
    schema_id: number;
    schema_ref: string;
    kind: AnnotationKind;
    created_by: number;
    created_at: Date;
    start_seconds: number | null;
    duration_seconds: number | null;
    tags: string[] | null;
    text_value: string | null;
    vector_value: number[] | null;
    kv: Record<string, unknown> | null;
    blob_url: string | null;
    blob_content_type: string | null;
    data: unknown;
    is_public: boolean;
    access_user_ids: number[] | null;
    deleted_at: Date | null;
    visible: boolean;
}

/** `$VIEWER` is replaced with the positional parameter holding the viewer's id */
const SELECT = `
    select a.id, a.sound_id, a.schema_id, s.name || '@' || s.version as schema_ref, s.kind,
           a.created_by, a.created_at, a.start_seconds, a.duration_seconds,
           a.tags, a.text_value, a.vector_value::real[] as vector_value, a.kv,
           a.blob_url, a.blob_content_type, a.data, a.is_public, a.deleted_at,
           (select array_agg(x.user_id order by x.user_id) from annotation_access x where x.annotation_id = a.id)
               as access_user_ids,
           (a.is_public or a.created_by = $VIEWER or exists (
               select 1 from annotation_access x where x.annotation_id = a.id and x.user_id = $VIEWER
           )) as visible
    from annotations a
    join annotation_schemas s on s.id = a.schema_id`;

const toValue = (row: AnnotationRow): AnnotationValue => {
    switch (row.kind) {
        case 'tags':
            return { kind: 'tags', tags: row.tags! };
        case 'text':
            return { kind: 'text', text: row.text_value! };
        case 'vector':
            return { kind: 'vector', vector: row.vector_value! };
        case 'kv':
            return { kind: 'kv', kv: row.kv! };
        case 'blob':
            return { kind: 'blob', blob: { url: row.blob_url!, contentType: row.blob_content_type! } };
    }
};

const toAccess = (row: AnnotationRow): Access =>
    row.is_public
        ? { type: 'public' }
        : row.access_user_ids?.length
          ? { type: 'users', userIds: row.access_user_ids as UserId[] }
          : { type: 'private' };

const toAnnotation = (row: AnnotationRow): Annotation => ({
    id: row.id as AnnotationId,
    soundId: row.sound_id as SoundId,
    schemaId: row.schema_id as AnnotationSchemaId,
    schemaRef: row.schema_ref as SchemaRef,
    createdBy: row.created_by as UserId,
    createdAt: row.created_at,
    segment:
        row.start_seconds === null
            ? null
            : { startSeconds: row.start_seconds, durationSeconds: row.duration_seconds! },
    value: toValue(row),
    data: row.data,
    access: toAccess(row),
});

const columnsFor = (value: AnnotationValue) => ({
    tags: value.kind === 'tags' ? value.tags : null,
    text: value.kind === 'text' ? value.text : null,
    vector: value.kind === 'vector' ? `[${value.vector.join(',')}]` : null,
    kv: value.kind === 'kv' ? JSON.stringify(value.kv) : null,
    blobUrl: value.kind === 'blob' ? value.blob.url : null,
    blobContentType: value.kind === 'blob' ? value.blob.contentType : null,
});

export const buildAnnotationsPersistence = (pool: pg.Pool): AnnotationsPersistence => ({
    async insertBatch(createdBy, soundId, annotations) {
        const ids = await withTransaction(pool, async (tx) => {
            // all validation has happened;  take the feed lock as late as possible
            await acquireFeedLock(tx, 'annotations');
            const ids: number[] = [];
            for (const a of annotations) {
                const c = columnsFor(a.value);
                const row = await executeQueryOne<{ id: number }>(
                    tx,
                    `insert into annotations (sound_id, schema_id, created_by, start_seconds, duration_seconds,
                                              tags, text_value, vector_value, kv, blob_url, blob_content_type,
                                              data, is_public)
                     values ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9, $10, $11, $12, $13)
                     returning id`,
                    [
                        soundId,
                        a.schemaId,
                        createdBy,
                        a.segment?.startSeconds ?? null,
                        a.segment?.durationSeconds ?? null,
                        c.tags,
                        c.text,
                        c.vector,
                        c.kv,
                        c.blobUrl,
                        c.blobContentType,
                        a.data === null || a.data === undefined ? null : JSON.stringify(a.data),
                        a.access.type === 'public',
                    ]
                );
                ids.push(row!.id);
                if (a.access.type === 'users' && a.access.userIds.length) {
                    await executeCommand(
                        tx,
                        'insert into annotation_access (annotation_id, user_id) select $1, unnest($2::bigint[])',
                        [row!.id, a.access.userIds]
                    );
                }
            }
            return ids;
        });
        const rows = await executeQuery<AnnotationRow>(
            pool,
            `${SELECT.replaceAll('$VIEWER', '$2')} where a.id = any($1::bigint[]) order by a.id`,
            [ids, createdBy]
        );
        return rows.map(toAnnotation);
    },

    async lookup(id, viewer) {
        const row = await executeQueryOne<AnnotationRow>(
            pool,
            `${SELECT.replaceAll('$VIEWER', '$2')} where a.id = $1`,
            [id, viewer]
        );
        if (!row) return { status: 'missing' };
        return { status: row.deleted_at ? 'deleted' : 'found', annotation: toAnnotation(row), visible: row.visible };
    },

    async feed(viewer, { lowId, pageSize, soundId, createdBy, schemaId, tags, timeRange }) {
        const rows = await executeQuery<AnnotationRow>(
            pool,
            `${SELECT.replaceAll('$VIEWER', '$1')}
             join sounds snd on snd.id = a.sound_id and snd.deleted_at is null
             where a.deleted_at is null
               and a.id > $2
               and (a.is_public or a.created_by = $1 or exists (
                   select 1 from annotation_access x where x.annotation_id = a.id and x.user_id = $1))
               and ($3::bigint is null or a.sound_id = $3)
               and ($4::bigint is null or a.created_by = $4)
               and ($5::bigint is null or a.schema_id = $5)
               and ($6::text[] is null or a.tags @> $6)
               and ($7::float8 is null or a.start_seconds is null
                    or (a.start_seconds <= $8 and a.start_seconds + a.duration_seconds >= $7))
             order by a.id
             limit $9`,
            [
                viewer,
                lowId ?? 0,
                soundId,
                createdBy,
                schemaId,
                tags,
                timeRange?.start ?? null,
                timeRange?.end ?? null,
                pageSize + 1,
            ]
        );
        return { items: rows.slice(0, pageSize).map(toAnnotation), hasMore: rows.length > pageSize };
    },

    async markDeleted(id, deletedBy) {
        await executeCommand(
            pool,
            'update annotations set deleted_at = now(), deleted_by = $2 where id = $1 and deleted_at is null',
            [id, deletedBy]
        );
    },
});
