/**
 * Sequential database upgrade scripts.
 *
 * Applies `api/sql/NNNN.description.sql` files in numeric order, each in its
 * own transaction, recording them in `schema_migrations`.  Fails loudly if a
 * previously-applied script has been edited (checksum mismatch);  write a
 * new script instead.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { createPool, executeQuery } from './pool';

export const SQL_DIR = join(__dirname, '..', '..', '..', 'sql');

interface Script {
    version: number;
    name: string;
    sql: string;
    checksum: string;
}

const MIGRATION_LOCK = 7_000;

export const loadScripts = (dir = SQL_DIR): Script[] => {
    const scripts = readdirSync(dir)
        .filter((f) => /^\d{4}\..+\.sql$/.test(f))
        .sort()
        .map((file) => {
            const sql = readFileSync(join(dir, file), 'utf8');
            return {
                version: Number(file.slice(0, 4)),
                name: file,
                sql,
                checksum: createHash('sha256').update(sql).digest('hex'),
            };
        });
    const versions = new Set<number>();
    for (const s of scripts) {
        if (versions.has(s.version)) {
            throw new Error(`Duplicate migration version ${s.version}`);
        }
        versions.add(s.version);
    }
    return scripts;
};

export const migrate = async (pool: pg.Pool, log = console.log): Promise<void> => {
    const client = await pool.connect();
    try {
        // only one migrator at a time
        await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
        await client.query(`
            create table if not exists schema_migrations (
                version    integer primary key,
                name       text not null,
                checksum   char(64) not null,
                applied_at timestamptz not null default now()
            )`);
        const applied = new Map(
            (
                await executeQuery<{ version: number; checksum: string; name: string }>(
                    client,
                    'select version, checksum, name from schema_migrations'
                )
            ).map((r) => [r.version, r])
        );

        for (const script of loadScripts()) {
            const prior = applied.get(script.version);
            if (prior) {
                if (prior.checksum.trim() !== script.checksum) {
                    throw new Error(
                        `Migration ${script.name} has changed since it was applied; ` +
                            'add a new migration instead of editing an applied one'
                    );
                }
                continue;
            }
            log(`applying ${script.name}`);
            await client.query('begin');
            try {
                await client.query(script.sql);
                await client.query(
                    'insert into schema_migrations (version, name, checksum) values ($1, $2, $3)',
                    [script.version, script.name, script.checksum]
                );
                await client.query('commit');
            } catch (err) {
                await client.query('rollback');
                throw new Error(`Migration ${script.name} failed: ${(err as Error).message}`);
            }
        }
        log('database is up to date');
    } finally {
        await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined);
        client.release();
    }
};

if (require.main === module) {
    const pool = createPool();
    migrate(pool)
        .then(() => pool.end())
        .catch(async (err) => {
            console.error(err.message);
            await pool.end();
            process.exit(1);
        });
}
