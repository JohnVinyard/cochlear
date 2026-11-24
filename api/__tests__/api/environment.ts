/**
 * The API test suite's own environment, so that tests never touch the
 * development database: a throwaway database (`cochlea_test`, dropped and
 * migrated afresh on every run) and an API server in the test process,
 * pointed at it. They share the dev stack's Postgres server, firebase auth
 * emulator and fake GCS (in a bucket of their own), so `docker compose up`
 * must be running.
 *
 * At the end, the firebase emulator accounts the tests signed up are deleted
 * (they're the firebase users in the test database). The test database is
 * kept until the next run, for poking at after a failure.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { createApp } from '../../src/app';
import { createFirebaseVerifier } from '../../src/auth/adapters/firebase';
import type { Config } from '../../src/config';
import { deleteEmulatorAccounts } from '../../src/devtools/firebaseEmulator';
import { migrate } from '../../src/shared/db/migrate';
import { createPool, dbConfigFromEnv } from '../../src/shared/db/pool';

export const TEST_DATABASE = process.env.TEST_PGDATABASE ?? 'cochlea_test';
const PROJECT_ID = 'demo-cochlea';
const GCS = 'localhost:4443';

interface Running {
    server: Server;
    pool: pg.Pool;
}

// shared by globalSetup and globalTeardown, which run in the same process
const state = globalThis as typeof globalThis & { __cochleaTests?: Running };

/** Only for the API group: unit tests need nothing running */
export const runningApiTests = () => process.argv.some((a) => /^--group=api\b/.test(a));

/** Deletes the firebase emulator accounts of a test database's users */
const deleteAccountsOf = async (pool: pg.Pool) => {
    const { rows } = await pool.query<{ firebase_uid: string }>(
        'select firebase_uid from users where firebase_uid is not null'
    );
    await deleteEmulatorAccounts(
        rows.map((r) => r.firebase_uid),
        PROJECT_ID
    );
};

const freshDatabase = async (base: pg.ClientConfig) => {
    const admin = new pg.Client({ ...base, database: 'postgres' });
    await admin.connect();
    try {
        // a run that was killed never tore down: delete its emulator accounts before its database goes
        const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', [TEST_DATABASE]);
        if (rowCount) {
            const previous = new pg.Pool({ ...base, database: TEST_DATABASE, max: 1 });
            try {
                await deleteAccountsOf(previous);
            } catch {
                /* e.g. an empty or half-migrated database: nothing to clean */
            } finally {
                await previous.end();
            }
        }
        await admin.query(`drop database if exists ${TEST_DATABASE} with (force)`);
        await admin.query(`create database ${TEST_DATABASE}`);
    } finally {
        await admin.end();
    }
};

export const setUp = async () => {
    if (!/^[a-z_]+_test$/.test(TEST_DATABASE)) {
        throw new Error(`refusing to use database "${TEST_DATABASE}": test databases are named *_test`);
    }
    process.env.FIREBASE_AUTH_EMULATOR_HOST ??= 'localhost:9099';
    const base = dbConfigFromEnv();
    await freshDatabase(base);
    const pool = createPool({ ...base, database: TEST_DATABASE });
    await migrate(pool, () => undefined);

    // listen first, on a free port, so the app knows its own address (for links)
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    const config: Config = {
        port,
        publicBaseUrl: `http://localhost:${port}`,
        corsOrigins: [],
        firebaseProjectId: PROJECT_ID,
        db: { ...base, database: TEST_DATABASE },
        blobs: {
            bucket: 'cochlea-test-blobs',
            projectId: PROJECT_ID,
            publicUrlTemplate: `http://${GCS}/storage/v1/b/cochlea-test-blobs/o/{key}?alt=media`,
            createBucket: true,
            apiEndpoint: `http://${GCS}`,
        },
    };
    server.on('request', createApp({ config, pool, verifyFirebaseToken: createFirebaseVerifier(PROJECT_ID) }));
    state.__cochleaTests = { server, pool };

    // read by client.ts; the tests run after this, in this process (--runInBand)
    process.env.API_BASE_URL = `http://localhost:${port}/v1`;
    process.env.PGDATABASE = TEST_DATABASE;
};

export const tearDown = async () => {
    const running = state.__cochleaTests;
    if (!running) return;
    await new Promise<void>((resolve) => running.server.close(() => resolve()));
    await deleteAccountsOf(running.pool);
    await running.pool.end();
};
