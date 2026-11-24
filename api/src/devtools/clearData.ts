import type pg from 'pg';
import { executeCommand, executeQueryOne, withTransaction } from '../shared/db/pool';

/** Hosts we're willing to wipe: the host machine, or the compose `postgres` service */
const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres']);

export const assertLocalDatabase = (host: string) => {
    if (!LOCAL_DB_HOSTS.has(host)) {
        throw new Error(
            `refusing to clear data on database host "${host}"; ` +
                `only ${[...LOCAL_DB_HOSTS].join(', ')} are allowed`
        );
    }
};

export interface ClearDataResult {
    sounds: number;
    annotations: number;
    /** Users whose (non-empty) state document was reset */
    states: number;
}

/**
 * Hard-deletes every sound (and its formats) and annotation (including soft-deleted ones), and
 * resets every user's state document to `{}`: bot state (e.g. a feed cursor)
 * describes data that's gone. State versions are bumped rather than reset,
 * so a bot's next conditional write fails (412) and it re-reads its state.
 * Users, API keys and annotation schemas are kept. Uploaded blobs are left in
 * the bucket; they're content-addressed, so leftovers are harmless.
 *
 * With `keepIds`, id sequences continue where they were, so clients holding a
 * feed cursor (`low_id`) still see every new item.
 */
export const clearSoundsAndAnnotations = (pool: pg.Pool, { keepIds }: { keepIds: boolean }) =>
    withTransaction(pool, async (tx): Promise<ClearDataResult> => {
        const counts = await executeQueryOne<ClearDataResult>(
            tx,
            `select (select count(*) from sounds)::int as sounds,
                    (select count(*) from annotations)::int as annotations,
                    (select count(*) from users where state <> '{}'::jsonb)::int as states`
        );
        await executeCommand(
            tx,
            `truncate annotation_access, annotations, sound_formats, sounds ${keepIds ? 'continue' : 'restart'} identity`
        );
        await executeCommand(
            tx,
            `update users set state = '{}'::jsonb, state_version = state_version + 1, state_updated_at = now()`
        );
        return counts!;
    });
