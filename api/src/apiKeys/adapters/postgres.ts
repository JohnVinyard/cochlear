import type { Role } from '@cochlea/shared';
import type pg from 'pg';
import { executeCommand, executeQuery, executeQueryOne, withTransaction } from '../../shared/db/pool';
import type { ApiKeyId, UserId } from '../../shared/ids';
import type { ApiKey, ApiKeysPersistence } from '../domain';

interface ApiKeyRow {
    id: number;
    user_id: number;
    name: string;
    key_prefix: string;
    created_at: Date;
    roles: Role[];
}

const SELECT_KEY = `
    select k.id, k.user_id, k.name, k.key_prefix, k.created_at,
           coalesce(array_agg(r.role::text order by r.role) filter (where r.role is not null), '{}') as roles
    from api_keys k
    left join api_key_roles r on r.api_key_id = k.id
    where k.deleted_at is null and %WHERE%
    group by k.id
    order by k.id`;

const toApiKey = (row: ApiKeyRow): ApiKey => ({
    id: row.id as ApiKeyId,
    userId: row.user_id as UserId,
    name: row.name,
    prefix: row.key_prefix,
    roles: row.roles,
    createdAt: row.created_at,
});

export const buildApiKeysPersistence = (pool: pg.Pool): ApiKeysPersistence => ({
    async insert(key) {
        const id = await withTransaction(pool, async (tx) => {
            const row = await executeQueryOne<{ id: number }>(
                tx,
                `insert into api_keys (user_id, name, key_hash, key_prefix, created_at)
                 values ($1, $2, $3, $4, $5) returning id`,
                [key.userId, key.name, key.hash, key.prefix, key.createdAt]
            );
            await executeCommand(
                tx,
                'insert into api_key_roles (api_key_id, role) select $1, unnest($2::role[])',
                [row!.id, key.roles]
            );
            return row!.id;
        });
        const row = await executeQueryOne<ApiKeyRow>(pool, SELECT_KEY.replace('%WHERE%', 'k.id = $1'), [id]);
        return toApiKey(row!);
    },

    async listActive(userId) {
        const rows = await executeQuery<ApiKeyRow>(pool, SELECT_KEY.replace('%WHERE%', 'k.user_id = $1'), [userId]);
        return rows.map(toApiKey);
    },

    async markDeleted(userId, id, deletedAt) {
        const n = await executeCommand(
            pool,
            `update api_keys set deleted_at = $3, deleted_by = $1
             where id = $2 and user_id = $1 and deleted_at is null`,
            [userId, id, deletedAt]
        );
        return n === 1;
    },

    async getActiveByHash(hash) {
        const row = await executeQueryOne<ApiKeyRow & { user_name: string; user_roles: Role[] }>(
            pool,
            `select k.*, u.user_name,
                    coalesce((select array_agg(ur.role::text) from user_roles ur where ur.user_id = u.id), '{}') as user_roles
             from (${SELECT_KEY.replace('%WHERE%', 'k.key_hash = $1')}) k
             join users u on u.id = k.user_id and u.deleted_at is null`,
            [hash]
        );
        return row ? { key: toApiKey(row), userName: row.user_name, userRoles: row.user_roles } : null;
    },
});
