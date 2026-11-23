import pg from 'pg';

// int8 (bigserial ids, counts) => number.  All ids are well below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
const INT8_ARRAY_OID = 1016 as Parameters<typeof pg.types.setTypeParser>[0]; // _int8
const parseTextArray = pg.types.getTypeParser(INT8_ARRAY_OID, 'text') as (v: string) => (string | null)[];
pg.types.setTypeParser(INT8_ARRAY_OID, (v) => parseTextArray(v).map((x) => (x === null ? null : Number(x))));

export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export interface DbConfig {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
}

export const dbConfigFromEnv = (env = process.env): DbConfig => ({
    host: env.PGHOST ?? 'localhost',
    port: Number(env.PGPORT ?? 5432),
    user: env.PGUSER ?? 'cochlea',
    password: env.PGPASSWORD ?? 'cochlea',
    database: env.PGDATABASE ?? 'cochlea',
});

export const createPool = (config: DbConfig = dbConfigFromEnv()): pg.Pool => {
    // NOTE: pgvector `vector` columns are read as `vector_value::real[]` and
    // written as `'[1,2,3]'::vector`, so no custom type parser is needed
    return new pg.Pool({ ...config, max: 10 });
};

export const executeQuery = async <TRow extends pg.QueryResultRow>(
    db: Queryable,
    sql: string,
    params: unknown[] = []
): Promise<TRow[]> => {
    const result = await db.query<TRow>(sql, params);
    return result.rows;
};

export const executeQueryOne = async <TRow extends pg.QueryResultRow>(
    db: Queryable,
    sql: string,
    params: unknown[] = []
): Promise<TRow | null> => {
    const rows = await executeQuery<TRow>(db, sql, params);
    return rows[0] ?? null;
};

/** Returns the number of affected rows */
export const executeCommand = async (
    db: Queryable,
    sql: string,
    params: unknown[] = []
): Promise<number> => {
    const result = await db.query(sql, params);
    return result.rowCount ?? 0;
};

export const withTransaction = async <T>(
    pool: pg.Pool,
    fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> => {
    const client = await pool.connect();
    try {
        await client.query('begin');
        const result = await fn(client);
        await client.query('commit');
        return result;
    } catch (err) {
        await client.query('rollback').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
};

/** Postgres error codes we translate into domain errors */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_CHECK_VIOLATION = '23514';

export const isPgError = (err: unknown, code: string): err is pg.DatabaseError =>
    err instanceof pg.DatabaseError && err.code === code;
