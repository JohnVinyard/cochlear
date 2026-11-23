import type { Queryable } from './db/pool';

/**
 * Feeds (`/sounds`, `/annotations`) are consumed by clients that remember
 * the last id they've seen and poll for `id > last_seen`.  With concurrent
 * writers, Postgres sequence values can *commit* out of order (txn A takes
 * id 5, txn B takes id 6, B commits first), so a poller could observe 6,
 * advance its offset, and never see 5.
 *
 * To make ids commit in order, every insert into a feed table happens while
 * holding a per-table transaction-scoped advisory lock, taken as late as
 * possible (after all validation) and released automatically at commit.
 * This serializes only the final insert + commit of each write.
 *
 * If write throughput ever makes this a bottleneck, the alternative is to
 * order feeds by `(xid8, id)` behind an opaque cursor, and only return rows
 * whose xid is below `pg_snapshot_xmin(pg_current_snapshot())`.
 */
export const FEED_LOCKS = {
    sounds: 7_001,
    annotations: 7_002,
} as const;

export type FeedTable = keyof typeof FEED_LOCKS;

export const acquireFeedLock = async (tx: Queryable, table: FeedTable): Promise<void> => {
    await tx.query('select pg_advisory_xact_lock($1)', [FEED_LOCKS[table]]);
};
