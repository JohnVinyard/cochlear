/** @group unit */
import { DEFAULT_USER_ROLES } from '@cochlea/shared';
import { InvalidRequest } from '../shared/errors';
import type { UserId } from '../shared/ids';
import { firebasePrincipal } from '../testing';
import { buildUsersDomain, type User, UserNameTaken, userNameFromEmail, type UsersPersistence } from './domain';

const inMemory = () => {
    const users: User[] = [];
    const persistence: UsersPersistence = {
        getById: async (id) => users.find((u) => u.id === id) ?? null,
        getByFirebaseUid: async (uid) => users.find((u) => u.firebaseUid === uid) ?? null,
        getByEmail: async (email) => users.find((u) => u.email === email) ?? null,
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
});
