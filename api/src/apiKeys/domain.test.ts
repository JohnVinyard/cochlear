/** @group unit */
import { API_KEY_GRANTABLE_ROLES } from '@cochlea/shared';
import { PermissionDenied, InvalidRequest, NotFound, Unauthenticated } from '../shared/errors';
import type { ApiKeyId, UserId } from '../shared/ids';
import { apiKeyPrincipal, firebasePrincipal } from '../testing';
import {
    type ApiKey,
    type ApiKeyCredentials,
    type ApiKeysPersistence,
    buildApiKeysDomain,
    generateApiKeySecret,
    hashApiKeySecret,
} from './domain';

const inMemory = () => {
    const keys: (ApiKey & { hash: string; deleted: boolean })[] = [];
    const userRoles = new Map<number, string[]>();
    const persistence: ApiKeysPersistence = {
        async insert(key) {
            const stored = { ...key, id: (keys.length + 1) as ApiKeyId, deleted: false };
            keys.push(stored);
            return stored;
        },
        async listActive(userId) {
            return keys.filter((k) => k.userId === userId && !k.deleted);
        },
        async markDeleted(userId, id) {
            const key = keys.find((k) => k.id === id && k.userId === userId && !k.deleted);
            if (key) key.deleted = true;
            return !!key;
        },
        async getActiveByHash(hash) {
            const key = keys.find((k) => k.hash === hash && !k.deleted);
            return key
                ? ({ key, userName: 'u', userRoles: userRoles.get(key.userId) ?? [] } as ApiKeyCredentials)
                : null;
        },
    };
    return { keys, userRoles, persistence };
};

describe('api keys', () => {
    it('generates prefixed, url-safe secrets', () => {
        const secret = generateApiKeySecret();
        expect(secret).toMatch(/^cka_[A-Za-z0-9_-]{43}$/);
        expect(hashApiKeySecret(secret)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('stores only the hash and a display prefix', async () => {
        const store = inMemory();
        const domain = buildApiKeysDomain(store.persistence);
        const created = await domain.createApiKey(firebasePrincipal(1), { name: ' bot ', roles: ['SOUND_READER'] });
        expect(created.name).toBe('bot');
        expect(created.secret.startsWith(created.prefix)).toBe(true);
        expect(store.keys[0]!.hash).toBe(hashApiKeySecret(created.secret));
        expect(JSON.stringify(store.keys)).not.toContain(created.secret);
    });

    it('only grants roles the creator holds', async () => {
        const domain = buildApiKeysDomain(inMemory().persistence);
        const actor = firebasePrincipal(1, ['API_KEY_CREATOR', 'SOUND_READER']);
        await expect(domain.createApiKey(actor, { name: 'k', roles: ['SOUND_EDITOR'] })).rejects.toThrow(
            InvalidRequest
        );
    });

    it('never grants API_KEY_CREATOR', async () => {
        const domain = buildApiKeysDomain(inMemory().persistence);
        await expect(
            domain.createApiKey(firebasePrincipal(1), { name: 'k', roles: ['API_KEY_CREATOR'] })
        ).rejects.toThrow(/may never be granted/);
    });

    it('cannot be managed with an API key', async () => {
        const domain = buildApiKeysDomain(inMemory().persistence);
        const actor = apiKeyPrincipal(1, [...API_KEY_GRANTABLE_ROLES, 'API_KEY_CREATOR']);
        await expect(domain.listApiKeys(actor)).rejects.toThrow(PermissionDenied);
        await expect(domain.createApiKey(actor, { name: 'k', roles: ['SOUND_READER'] })).rejects.toThrow(
            PermissionDenied
        );
    });

    it("intersects a key's roles with its owner's current roles", async () => {
        const store = inMemory();
        const domain = buildApiKeysDomain(store.persistence);
        const created = await domain.createApiKey(firebasePrincipal(7), {
            name: 'k',
            roles: ['SOUND_READER', 'SOUND_EDITOR'],
        });
        store.userRoles.set(7, ['SOUND_READER']);
        const principal = await domain.authenticateApiKey(created.secret);
        expect(principal.kind).toBe('apiKey');
        expect([...principal.roles]).toEqual(['SOUND_READER']);
        expect(principal.user.id).toBe(7 as UserId);
    });

    it('rejects unknown, malformed and deleted keys', async () => {
        const store = inMemory();
        const domain = buildApiKeysDomain(store.persistence);
        const actor = firebasePrincipal(1);
        const created = await domain.createApiKey(actor, { name: 'k', roles: ['SOUND_READER'] });
        await expect(domain.authenticateApiKey('nope')).rejects.toThrow(Unauthenticated);
        await expect(domain.authenticateApiKey(generateApiKeySecret())).rejects.toThrow(Unauthenticated);
        await domain.deleteApiKey(actor, created.id);
        await expect(domain.authenticateApiKey(created.secret)).rejects.toThrow(Unauthenticated);
        await expect(domain.deleteApiKey(actor, created.id)).rejects.toThrow(NotFound);
    });

    describe('issueApiKey (administrative)', () => {
        it('issues a key without a principal, limited to the owner\'s roles', async () => {
            const store = inMemory();
            const domain = buildApiKeysDomain(store.persistence);
            const owner = { id: 7 as UserId, roles: ['SOUND_READER', 'SOUND_EDITOR'] as const };
            const key = await domain.issueApiKey(owner, { name: 'cli', roles: ['SOUND_EDITOR'] });
            expect(key).toMatchObject({ userId: 7, roles: ['SOUND_EDITOR'] });
            await expect(
                domain.issueApiKey(owner, { name: 'cli', roles: ['ANNOTATION_EDITOR'] })
            ).rejects.toThrow(InvalidRequest);
            await expect(
                domain.issueApiKey({ ...owner, roles: ['API_KEY_CREATOR'] }, { name: 'cli', roles: ['API_KEY_CREATOR'] })
            ).rejects.toThrow(InvalidRequest);
        });
    });
});
