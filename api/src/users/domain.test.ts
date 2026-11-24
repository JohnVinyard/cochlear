/** @group unit */
import { DEFAULT_USER_ROLES } from '@cochlea/shared';
import { InvalidRequest, PreconditionFailed } from '../shared/errors';
import type { UserId } from '../shared/ids';
import { firebasePrincipal } from '../testing';
import {
    buildUsersDomain,
    MAX_STATE_BYTES,
    type User,
    UserNameTaken,
    userNameFromEmail,
    type UserState,
    type UsersPersistence,
} from './domain';

const inMemory = () => {
    const users: User[] = [];
    const states = new Map<UserId, UserState>();
    const persistence: UsersPersistence = {
        getState: async (id) => states.get(id) ?? { document: {}, version: 0, updatedAt: null },
        async putState(id, document, ifVersion) {
            const current = await persistence.getState(id);
            if (ifVersion !== null && ifVersion !== current.version) return null;
            const next = { document, version: current.version + 1, updatedAt: new Date() };
            states.set(id, next);
            return next;
        },
        getById: async (id) => users.find((u) => u.id === id) ?? null,
        getByFirebaseUid: async (uid) => users.find((u) => u.firebaseUid === uid) ?? null,
        getByEmail: async (email) => users.find((u) => u.email === email) ?? null,
        getByUserName: async (name) => users.find((u) => u.userName === name) ?? null,
        async insert(user) {
            if (users.some((u) => u.userName === user.userName)) throw new UserNameTaken(user.userName);
            const created: User = {
                ...user,
                id: (users.length + 1) as UserId,
                aboutMe: '',
                infoUrl: null,
                createdAt: new Date(),
                roles: [...user.roles],
            };
            users.push(created);
            return created;
        },
        async update(id, update) {
            const user = users.find((u) => u.id === id)!;
            Object.assign(user, Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined)));
        },
        existingIds: async (ids) => new Set(ids.filter((id) => users.some((u) => u.id === id))),
        grantRole: async (id, role) => void users.find((u) => u.id === id)!.roles.push(role),
        revokeRole: async () => undefined,
    };
    return { users, persistence };
};

describe('users', () => {
    it('derives user names from email addresses', () => {
        expect(userNameFromEmail('jane.doe+x@example.com')).toBe('jane.doex');
        expect(userNameFromEmail(null)).toBe('user');
    });

    it('auto-provisions firebase users with the default roles, exactly once', async () => {
        const store = inMemory();
        const domain = buildUsersDomain(store.persistence);
        const a = await domain.principalForFirebaseIdentity({ uid: 'abc', email: 'jane@example.com' });
        const b = await domain.principalForFirebaseIdentity({ uid: 'abc', email: 'jane@example.com' });
        expect(a.user.id).toBe(b.user.id);
        expect(store.users).toHaveLength(1);
        expect([...a.roles].sort()).toEqual([...DEFAULT_USER_ROLES].sort());
    });

    it('disambiguates colliding user names', async () => {
        const store = inMemory();
        const domain = buildUsersDomain(store.persistence, () => 0.5);
        await domain.principalForFirebaseIdentity({ uid: '1', email: 'jane@a.com' });
        const second = await domain.principalForFirebaseIdentity({ uid: '2', email: 'jane@b.com' });
        expect(second.user.userName).toMatch(/^jane-[0-9a-f]{6}$/);
    });

    it('reports unknown user ids', async () => {
        const store = inMemory();
        const domain = buildUsersDomain(store.persistence);
        await domain.principalForFirebaseIdentity({ uid: '1', email: 'a@a.com' });
        await expect(domain.requireUsersExist([1 as UserId])).resolves.toBeUndefined();
        await expect(domain.requireUsersExist([1 as UserId, 99 as UserId])).rejects.toThrow(/99/);
    });

    it('validates user names on update', async () => {
        const domain = buildUsersDomain(inMemory().persistence);
        await expect(domain.updateMe(firebasePrincipal(1), { userName: 'no spaces' })).rejects.toThrow(
            InvalidRequest
        );
    });

    describe('bot users', () => {
        it('creates a bot without a firebase identity', async () => {
            const domain = buildUsersDomain(inMemory().persistence);
            const bot = await domain.ensureBotUser({
                userName: 'musicnet',
                aboutMe: 'Imports MusicNet',
                roles: ['SOUND_EDITOR'],
            });
            expect(bot).toMatchObject({ userName: 'musicnet', firebaseUid: null, email: null });
            expect(bot.aboutMe).toBe('Imports MusicNet');
            expect(bot.roles).toEqual(['SOUND_EDITOR']);
        });

        it('is idempotent, and adds missing roles', async () => {
            const store = inMemory();
            const domain = buildUsersDomain(store.persistence);
            const first = await domain.ensureBotUser({ userName: 'musicnet', roles: ['SOUND_EDITOR'] });
            const second = await domain.ensureBotUser({
                userName: 'musicnet',
                roles: ['SOUND_EDITOR', 'ANNOTATION_EDITOR'],
            });
            expect(second.id).toBe(first.id);
            expect(store.users).toHaveLength(1);
            expect(second.roles).toEqual(['SOUND_EDITOR', 'ANNOTATION_EDITOR']);
        });

        it('refuses to turn a firebase user into a bot', async () => {
            const domain = buildUsersDomain(inMemory().persistence);
            await domain.principalForFirebaseIdentity({ uid: 'abc', email: 'jane@example.com' });
            await expect(domain.ensureBotUser({ userName: 'jane', roles: [] })).rejects.toThrow(InvalidRequest);
        });
    });

    describe('state documents', () => {
        const setup = async () => {
            const domain = buildUsersDomain(inMemory().persistence);
            return { domain, me: await domain.principalForFirebaseIdentity({ uid: 'bot', email: null }) };
        };

        it('start empty, and are replaced on every write', async () => {
            const { domain, me } = await setup();
            expect(await domain.getMyState(me)).toMatchObject({ document: {}, version: 0 });
            await domain.putMyState(me, { cursor: 3, extra: true });
            expect(await domain.putMyState(me, { cursor: 4 })).toMatchObject({ document: { cursor: 4 }, version: 2 });
        });

        it('are only written conditionally when the version still matches', async () => {
            const { domain, me } = await setup();
            const { version } = await domain.putMyState(me, { cursor: 1 });
            await domain.putMyState(me, { cursor: 2 }, version);
            await expect(domain.putMyState(me, { cursor: 99 }, version)).rejects.toThrow(PreconditionFailed);
            expect((await domain.getMyState(me)).document).toEqual({ cursor: 2 });
        });

        it('must be small JSON objects', async () => {
            const { domain, me } = await setup();
            for (const bad of [null, [1], 'x', 3]) {
                await expect(domain.putMyState(me, bad)).rejects.toThrow(InvalidRequest);
            }
            await expect(domain.putMyState(me, { big: 'x'.repeat(MAX_STATE_BYTES) })).rejects.toThrow(/limit/);
        });
    });
});
