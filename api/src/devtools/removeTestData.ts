import type pg from 'pg';
import { executeCommand, executeQuery, executeQueryOne, withTransaction } from '../shared/db/pool';
import { vectorIndexName } from '../shared/db/vectors';

/**
 * Test data, by a rule that doesn't depend on how it got there: example.com
 * is reserved for examples (RFC 2606), so nothing real lives there.
 *
 *  - users whose email is @example.com (API test users, smoke tests), and
 *    everything they own: sounds, formats, annotations, schemas (and their
 *    vector indices), API keys, roles;
 *  - sounds whose audio is on example.com, whoever registered them, and
 *    everything on them (formats, and annotations, whoever made them).
 */
const TEST_USERS = `select id from users where email ilike '%@example.com'`;
const TEST_SOUNDS = `select id from sounds
    where created_by in (${TEST_USERS}) or audio_url ~* '^https?://([^/]*\\.)?example\\.com(/|:|$)'`;
const TEST_SCHEMAS = `select id from annotation_schemas where created_by in (${TEST_USERS})`;
const DOOMED_ANNOTATIONS = `select id from annotations
    where created_by in (${TEST_USERS}) or sound_id in (${TEST_SOUNDS}) or schema_id in (${TEST_SCHEMAS})`;

export interface TestDataCounts {
    users: number;
    sounds: number;
    schemas: number;
    annotations: number;
    vectorIndexes: number;
    /** Annotations by real users that go because they're on test sounds */
    realUsersAnnotations: number;
}

export interface RemovedTestData extends TestDataCounts {
    /** Firebase uids of the removed users, to delete from the emulator */
    firebaseUids: string[];
    /** Vector indices of the removed schemas, to drop (concurrently, after the deletes commit) */
    vectorIndexNames: string[];
}

/**
 * Every single-column foreign key in the public schema has no dangling
 * references. The deletes run with per-row reference checks off (with them,
 * deleting 1,700 users means 1,700 scans of the annotations table, whose
 * indices only cover live rows), so this is what makes them safe: one
 * set-based check per key, and any violation rolls everything back.
 */
const assertReferentialIntegrity = async (tx: pg.PoolClient) => {
    const keys = await executeQuery<{ name: string; child: string; col: string; parent: string; pcol: string }>(
        tx,
        `select c.conname as name, cl.relname as child, a.attname as col, pcl.relname as parent, pa.attname as pcol
         from pg_constraint c
         join pg_class cl on cl.oid = c.conrelid
         join pg_class pcl on pcl.oid = c.confrelid
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
         join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1]
         where c.contype = 'f' and cardinality(c.conkey) = 1 and cl.relnamespace = 'public'::regnamespace`
    );
    const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
    const broken: string[] = [];
    for (const k of keys) {
        const n = await count(
            tx,
            `select 1 from ${q(k.child)} c where c.${q(k.col)} is not null
             and not exists (select 1 from ${q(k.parent)} p where p.${q(k.pcol)} = c.${q(k.col)})`
        );
        if (n) broken.push(`${k.name}: ${n} rows of ${k.child}.${k.col} point at missing ${k.parent}`);
    }
    if (broken.length) throw new Error(`removing test data would leave dangling references; nothing was removed:\n${broken.join('\n')}`);
};

const count = async (db: pg.Pool | pg.PoolClient, sql: string) =>
    Number((await executeQueryOne<{ n: string }>(db, `select count(*) as n from (${sql}) t`))!.n);

export const countTestData = async (db: pg.Pool | pg.PoolClient): Promise<TestDataCounts> => {
    const vectorSchemas = await executeQuery<{ id: number }>(
        db,
        `select id from annotation_schemas where kind = 'vector' and id in (${TEST_SCHEMAS})`
    );
    return {
        users: await count(db, TEST_USERS),
        sounds: await count(db, TEST_SOUNDS),
        schemas: await count(db, TEST_SCHEMAS),
        annotations: await count(db, DOOMED_ANNOTATIONS),
        vectorIndexes: vectorSchemas.length,
        realUsersAnnotations: await count(
            db,
            `select id from annotations where sound_id in (${TEST_SOUNDS})
             and created_by not in (${TEST_USERS})`
        ),
    };
};

/**
 * Hard-deletes all test data (see above), in one transaction. The caller then
 * drops `vectorIndexNames` (see dropIndexes) and the firebase accounts.
 */
export const removeTestData = (pool: pg.Pool): Promise<RemovedTestData> =>
    withTransaction(pool, async (tx) => {
        // reference checks off for these deletes, and verified as a whole at the end (assertReferentialIntegrity);
        // this also skips the count triggers, so the counts are recomputed at the end too
        await executeCommand(tx, 'set local session_replication_role = replica');
        const counts = await countTestData(tx);
        const firebaseUids = (
            await executeQuery<{ firebase_uid: string }>(
                tx,
                `select firebase_uid from users where id in (${TEST_USERS}) and firebase_uid is not null`
            )
        ).map((r) => r.firebase_uid);
        const vectorSchemas = await executeQuery<{ id: number }>(
            tx,
            `select id from annotation_schemas where kind = 'vector' and id in (${TEST_SCHEMAS})`
        );

        // the doomed, fixed before anything is deleted (the definitions refer to each other)
        await executeCommand(tx, `create temp table doomed_users on commit drop as ${TEST_USERS}`);
        await executeCommand(tx, `create temp table doomed_sounds on commit drop as ${TEST_SOUNDS}`);
        await executeCommand(tx, `create temp table doomed_schemas on commit drop as ${TEST_SCHEMAS}`);
        await executeCommand(tx, `create temp table doomed_annotations on commit drop as ${DOOMED_ANNOTATIONS}`);

        await executeCommand(
            tx,
            `delete from annotation_access
             where annotation_id in (select id from doomed_annotations) or user_id in (select id from doomed_users)`
        );
        await executeCommand(tx, 'delete from annotations where id in (select id from doomed_annotations)');
        await executeCommand(
            tx,
            `delete from sound_formats
             where sound_id in (select id from doomed_sounds) or created_by in (select id from doomed_users)`
        );
        await executeCommand(tx, 'delete from sounds where id in (select id from doomed_sounds)');
        await executeCommand(tx, 'delete from annotation_schema_counts where schema_id in (select id from doomed_schemas)');
        await executeCommand(tx, 'delete from annotation_schemas where id in (select id from doomed_schemas)');
        await executeCommand(
            tx,
            `delete from api_key_roles where api_key_id in (select id from api_keys where user_id in (select id from doomed_users))`
        );
        await executeCommand(tx, 'delete from api_keys where user_id in (select id from doomed_users)');
        await executeCommand(tx, 'delete from user_roles where user_id in (select id from doomed_users)');
        await executeCommand(tx, 'delete from users where id in (select id from doomed_users)');

        await assertReferentialIntegrity(tx);

        // recount (hard deletes, and the triggers were off)
        await executeCommand(
            tx,
            `update annotation_schema_counts c set public_annotations = (
                 select count(*) from annotations a where a.schema_id = c.schema_id and a.deleted_at is null and a.is_public)`
        );
        return { ...counts, firebaseUids, vectorIndexNames: vectorSchemas.map(({ id }) => vectorIndexName(id)) };
    });

/**
 * Drops indices one at a time, concurrently: a plain `drop index` takes a lock
 * on the whole annotations table, which would stall every query of it.
 */
export const dropIndexes = async (pool: pg.Pool, names: string[]) => {
    for (const name of names) await executeCommand(pool, `drop index concurrently if exists ${name}`);
};
