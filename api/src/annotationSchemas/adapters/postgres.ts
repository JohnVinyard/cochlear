import type { AnnotationKind } from '@cochlea/shared';
import type pg from 'pg';
import { executeCommand, executeQuery, executeQueryOne, withTransaction } from '../../shared/db/pool';
import { createVectorIndex, vectorIndexName } from '../../shared/db/vectors';
import type { AnnotationSchemaId, UserId } from '../../shared/ids';
import type { AnnotationSchema, AnnotationSchemasPersistence } from '../domain';

interface SchemaRow {
    id: number;
    name: string;
    version: number;
    kind: AnnotationKind;
    vector_dim: number | null;
    json_schema: object | null;
    description: string;
    created_at: Date;
    created_by: number;
}

const COLUMNS = 'id, name, version, kind, vector_dim, json_schema, description, created_at, created_by';

const toSchema = (row: SchemaRow): AnnotationSchema => ({
    id: row.id as AnnotationSchemaId,
    name: row.name,
    version: row.version,
    kind: row.kind,
    vectorDim: row.vector_dim,
    jsonSchema: row.json_schema,
    description: row.description,
    createdAt: row.created_at,
    createdBy: row.created_by as UserId,
});

export const buildAnnotationSchemasPersistence = (pool: pg.Pool): AnnotationSchemasPersistence => {
    // one index build at a time: each scans the whole annotations table
    let queue: Promise<unknown> = Promise.resolve();
    const persistence: AnnotationSchemasPersistence = {
        async vectorSchemas() {
            const rows = await executeQuery<SchemaRow>(
                pool,
                `select ${COLUMNS} from annotation_schemas where kind = 'vector' order by id`
            );
            return rows.map(toSchema);
        },

        scheduleVectorIndex(schema) {
            queue = queue
                .then(() => persistence.ensureVectorIndex(schema))
                .then((outcome) => outcome === 'created' && console.log(`built the vector index for ${schema.name}@${schema.version}`))
                .catch((err) => console.error(`building the vector index for ${schema.name}@${schema.version} failed:`, err));
        },

        async ensureVectorIndex(schema) {
            const name = vectorIndexName(schema.id);
            const existing = await executeQueryOne<{ valid: boolean }>(
                pool,
                `select i.indisvalid as valid from pg_class c join pg_index i on i.indexrelid = c.oid
                 where c.relname = $1`,
                [name]
            );
            if (existing?.valid) return 'exists';
            // an interrupted `create index concurrently` leaves an invalid index behind
            if (existing) await executeCommand(pool, `drop index concurrently if exists ${name}`);
            // concurrently: don't block writes to annotations while it builds
            await executeCommand(pool, createVectorIndex(schema.id, schema.vectorDim!));
            return 'created';
        },

        async insertNextVersion(createdBy, schema) {
            return withTransaction(pool, async (tx) => {
                // serialize version allocation per schema name
                await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`schema:${schema.name}`]);
                const latest = await executeQueryOne<{ version: number; created_by: number }>(
                    tx,
                    'select version, created_by from annotation_schemas where name = $1 order by version desc limit 1',
                    [schema.name]
                );
                if (latest && latest.created_by !== createdBy) return { status: 'notOwner' as const };
                const row = await executeQueryOne<SchemaRow>(
                    tx,
                    `insert into annotation_schemas (name, version, kind, vector_dim, json_schema, description, created_by)
                     values ($1, $2, $3, $4, $5, $6, $7)
                     returning ${COLUMNS}`,
                    [
                        schema.name,
                        (latest?.version ?? 0) + 1,
                        schema.kind,
                        schema.vectorDim,
                        schema.jsonSchema === null ? null : JSON.stringify(schema.jsonSchema),
                        schema.description,
                        createdBy,
                    ]
                );
                return { status: 'created' as const, schema: toSchema(row!) };
            });
        },

        async getByRef(name, version) {
            const row = await executeQueryOne<SchemaRow>(
                pool,
                `select ${COLUMNS} from annotation_schemas where name = $1 and version = $2`,
                [name, version]
            );
            return row ? toSchema(row) : null;
        },

        async getByRefs(refs) {
            if (!refs.length) return [];
            const rows = await executeQuery<SchemaRow>(
                pool,
                `select ${COLUMNS} from annotation_schemas s
                 join unnest($1::text[], $2::int[]) as r(name, version) using (name, version)`,
                [refs.map((r) => r.name), refs.map((r) => r.version)]
            );
            return rows.map(toSchema);
        },

        async getById(id) {
            const row = await executeQueryOne<SchemaRow>(pool, `select ${COLUMNS} from annotation_schemas where id = $1`, [id]);
            return row ? toSchema(row) : null;
        },

        async feed({ lowId, pageSize }) {
            const rows = await executeQuery<SchemaRow>(
                pool,
                `select ${COLUMNS} from annotation_schemas where id > $1 order by id limit $2`,
                [lowId ?? 0, pageSize + 1]
            );
            return { items: rows.slice(0, pageSize).map(toSchema), hasMore: rows.length > pageSize };
        },
    };
    return persistence;
};
