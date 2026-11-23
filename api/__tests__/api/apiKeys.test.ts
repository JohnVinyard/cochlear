/** @group api */
import { closeDb, createApiKey, newUser, revokeRole, TestClient } from './client';

afterAll(closeDb);

describe('api keys', () => {
    it('creates a key, shows its secret once, and authenticates with it', async () => {
        const user = await newUser();
        const created = await user.client.post('/api-keys', { name: 'my bot', roles: ['SOUND_READER'] });
        expect(created.status).toBe(201);
        expect(created.body.secret).toMatch(/^cka_/);
        expect(created.body.secret.startsWith(created.body.prefix)).toBe(true);
        expect(created.headers.get('location')).toBe(created.body.links.self);

        const list = await user.client.get('/api-keys');
        expect(list.body.items).toHaveLength(1);
        expect(list.body.items[0]).not.toHaveProperty('secret');
        expect(list.body.items[0]).toMatchObject({ name: 'my bot', roles: ['SOUND_READER'] });
    });

    it('limits a key to its roles', async () => {
        const user = await newUser();
        const key = await createApiKey(user, ['SOUND_READER']);
        const me = await key.get('/users/me');
        expect(me.status).toBe(200);
        expect(me.body.id).toBe(user.id);
        expect((await key.get('/sounds')).status).toBe(200);
        expect((await key.get('/annotations')).status).toBe(403);
    });

    it('only grants roles the user holds, and never API_KEY_CREATOR', async () => {
        const user = await newUser();
        const superset = await user.client.post('/api-keys', { name: 'k', roles: ['ANNOTATION_SCHEMA_CREATOR'] });
        expect(superset.status).toBe(400);
        expect(superset.body.errors.join()).toMatch(/only grant roles you hold/);
        const creator = await user.client.post('/api-keys', { name: 'k', roles: ['API_KEY_CREATOR'] });
        expect(creator.status).toBe(400);
        expect((await user.client.post('/api-keys', { name: 'k', roles: [] })).status).toBe(400);
        expect((await user.client.post('/api-keys', { name: 'k', roles: ['NOPE'] })).status).toBe(400);
    });

    it('cannot manage keys with a key', async () => {
        const user = await newUser();
        const key = await createApiKey(user, ['SOUND_READER', 'SOUND_EDITOR']);
        expect((await key.get('/api-keys')).status).toBe(403);
        expect((await key.post('/api-keys', { name: 'k', roles: ['SOUND_READER'] })).status).toBe(403);
    });

    it("loses roles its owner loses", async () => {
        const user = await newUser();
        const key = await createApiKey(user, ['SOUND_READER', 'SOUND_EDITOR']);
        await revokeRole(user, 'SOUND_EDITOR');
        expect((await key.get('/sounds')).status).toBe(200);
        expect((await key.post('/sounds', {})).status).not.toBe(403); // body validation fails first...
        const create = await key.post('/sounds', {
            audio_url: `https://example.com/${user.id}.wav`,
            license_type: 'https://creativecommons.org/licenses/by/4.0',
            duration_seconds: 1,
        });
        expect(create.status).toBe(403); // ...but the domain refuses
    });

    it("can be deleted, only by its owner", async () => {
        const user = await newUser();
        const other = await newUser();
        const created = await user.client.post('/api-keys', { name: 'k', roles: ['SOUND_READER'] });
        expect((await other.client.delete(`/api-keys/${created.body.id}`)).status).toBe(404);
        expect((await user.client.delete(`/api-keys/${created.body.id}`)).status).toBe(204);
        expect((await user.client.delete(`/api-keys/${created.body.id}`)).status).toBe(404);
        const key = TestClient.withToken(created.body.secret);
        expect((await key.get('/users/me')).status).toBe(401);
        expect((await user.client.get('/api-keys')).body.items).toHaveLength(0);
    });
});
