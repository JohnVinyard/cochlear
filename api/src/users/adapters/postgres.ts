import type { Role } from '@cochlea/shared';
import type pg from 'pg';
import {
    executeCommand,
    executeQuery,
    executeQueryOne,
    isPgError,
    PG_UNIQUE_VIOLATION,
    withTransaction,
} from '../../shared/db/pool';
import type { UserId } from '../../shared/ids';
import { type User, UserNameTaken, type UserState, type UsersPersistence } from '../domain';

interface StateRow {
    state: Record<string, unknown>;
    state_version: number;
    state_updated_at: Date | null;
}

const toState = (row: StateRow): UserState => ({
    document: row.state,
    version: Number(row.state_version),
    updatedAt: row.state_updated_at,
});

interface UserRow {
    id: number;
    firebase_uid: string | null;
    user_name: string;
    email: string | null;
    about_me: string;
    info_url: string | null;
    created_at: Date;
    roles: Role[];
}

const SELECT_USER = `
    select u.id, u.firebase_uid, u.user_name, u.email, u.about_me, u.info_url, u.created_at,
           coalesce(array_agg(r.role::text order by r.role) filter (where r.role is not null), '{}') as roles
    from users u
    left join user_roles r on r.user_id = u.id
    where u.deleted_at is null and %WHERE%
    group by u.id`;

const toUser = (row: UserRow): User => ({
    id: row.id as UserId,
    firebaseUid: row.firebase_uid,
    userName: row.user_name,
    email: row.email,
    aboutMe: row.about_me,
    infoUrl: row.info_url,
    createdAt: row.created_at,
    roles: row.roles,
});

export const buildUsersPersistence = (pool: pg.Pool): UsersPersistence => {
    const getOne = async (where: string, param: unknown) => {
        const row = await executeQueryOne<UserRow>(pool, SELECT_USER.replace('%WHERE%', where), [param]);
        return row ? toUser(row) : null;
    };

    return {
        async getState(id) {
            const row = await executeQueryOne<StateRow>(
                pool,
                'select state, state_version, state_updated_at from users where id = $1',
                [id]
            );
            if (!row) throw new Error(`no user ${id}`);
            return toState(row);
        },

        async putState(id, document, ifVersion) {
            const row = await executeQueryOne<StateRow>(
                pool,
                `update users
                 set state = $2::jsonb, state_version = state_version + 1, state_updated_at = now()
                 where id = $1 and ($3::bigint is null or state_version = $3)
                 returning state, state_version, state_updated_at`,
                [id, JSON.stringify(document), ifVersion]
            );
            return row ? toState(row) : null;
        },

        getById: (id) => getOne('u.id = $1', id),
        getByFirebaseUid: (uid) => getOne('u.firebase_uid = $1', uid),
        getByEmail: (email) => getOne('lower(u.email) = lower($1)', email),
        getByUserName: (userName) => getOne('u.user_name = $1', userName),

        async insert(user) {
            try {
                const id = await withTransaction(pool, async (tx) => {
                    const row = await executeQueryOne<{ id: number }>(
                        tx,
                        `insert into users (firebase_uid, user_name, email) values ($1, $2, $3) returning id`,
                        [user.firebaseUid, user.userName, user.email]
                    );
                    await executeCommand(
                        tx,
                        `insert into user_roles (user_id, role) select $1, unnest($2::role[])`,
                        [row!.id, user.roles]
                    );
                    return row!.id as UserId;
                });
                return (await getOne('u.id = $1', id))!;
            } catch (err) {
                if (isPgError(err, PG_UNIQUE_VIOLATION) && err.constraint === 'users_user_name_key') {
                    throw new UserNameTaken(user.userName);
                }
                throw err;
            }
        },

        async update(id, update) {
            const sets: string[] = [];
            const params: unknown[] = [id];
            const set = (column: string, value: unknown) => {
                params.push(value);
                sets.push(`${column} = $${params.length}`);
            };
            if (update.userName !== undefined) set('user_name', update.userName);
            if (update.aboutMe !== undefined) set('about_me', update.aboutMe);
            if (update.infoUrl !== undefined) set('info_url', update.infoUrl);
            if (!sets.length) return;
            try {
                await executeCommand(pool, `update users set ${sets.join(', ')} where id = $1`, params);
            } catch (err) {
                if (isPgError(err, PG_UNIQUE_VIOLATION) && err.constraint === 'users_user_name_key') {
                    throw new UserNameTaken(update.userName ?? '');
                }
                throw err;
            }
        },

        async existingIds(ids) {
            if (!ids.length) return new Set();
            const rows = await executeQuery<{ id: number }>(
                pool,
                'select id from users where id = any($1::bigint[]) and deleted_at is null',
                [ids]
            );
            return new Set(rows.map((r) => r.id as UserId));
        },

        async grantRole(id, role) {
            await executeCommand(
                pool,
                'insert into user_roles (user_id, role) values ($1, $2) on conflict do nothing',
                [id, role]
            );
        },

        async revokeRole(id, role) {
            await executeCommand(pool, 'delete from user_roles where user_id = $1 and role = $2', [id, role]);
        },
    };
};
