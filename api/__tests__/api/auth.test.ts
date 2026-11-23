/** @group api */
import { DEFAULT_USER_ROLES } from '@cochlea/shared';
import { closeDb, newUser, TestClient } from './client';

afterAll(closeDb);

describe('authentication', () => {
    it('requires an Authorization header', async () => {
        const res = await TestClient.anonymous().get('/sounds');
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toBe('Bearer');
        expect(res.body.errors).toEqual(['Authentication required']);
    });

    it('rejects non-bearer schemes', async () => {
        const res = await TestClient.withAuthorizationHeader('Basic dXNlcjpwYXNz').get('/sounds');
        expect(res.status).toBe(401);
    });

    it('rejects invalid firebase tokens', async () => {
        const res = await TestClient.withToken('not-a-jwt').get('/users/me');
        expect(res.status).toBe(401);
    });

    it('rejects unknown api keys', async () => {
        const res = await TestClient.withToken('cka_' + 'x'.repeat(43)).get('/users/me');
        expect(res.status).toBe(401);
    });

    it('leaves the spec and health check open', async () => {
        expect((await TestClient.anonymous().get('/openapi.json')).status).toBe(200);
        expect((await TestClient.anonymous().get('/health')).status).toBe(200);
    });

    it('returns 404 for unknown routes, after authenticating', async () => {
        expect((await TestClient.anonymous().get('/nope')).status).toBe(401);
        const user = await newUser();
        expect((await user.client.get('/nope')).status).toBe(404);
    });
});

describe('users', () => {
    it('auto-provisions firebase users with the default roles', async () => {
        const user = await newUser('provision');
        const me = await user.client.get('/users/me');
        expect(me.body).toMatchObject({ id: user.id, email: user.email, user_name: expect.stringMatching(/^provision-/) });
        expect([...me.body.roles].sort()).toEqual([...DEFAULT_USER_ROLES].sort());
        // and only once
        expect((await user.client.get('/users/me')).body.id).toBe(user.id);
    });

    it('serves an entry point with links', async () => {
        const user = await newUser();
        const root = await user.client.get('/');
        expect(root.status).toBe(200);
        const sounds = await user.client.get(root.body.links.sounds);
        expect(sounds.status).toBe(200);
    });

    it("hides other users' email and roles", async () => {
        const a = await newUser();
        const b = await newUser();
        const res = await a.client.get(`/users/${b.id}`);
        expect(res.status).toBe(200);
        expect(res.body.user_name).toBe(b.userName);
        expect(res.body).not.toHaveProperty('email');
        expect(res.body).not.toHaveProperty('roles');
    });

    it('updates your profile', async () => {
        const user = await newUser();
        const res = await user.client.patch('/users/me', {
            about_me: 'I annotate',
            info_url: 'https://example.com/me',
            user_name: `renamed-${user.id}`,
        });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ about_me: 'I annotate', user_name: `renamed-${user.id}` });
    });

    it('rejects taken and invalid user names', async () => {
        const a = await newUser();
        const b = await newUser();
        expect((await b.client.patch('/users/me', { user_name: a.userName })).status).toBe(400);
        expect((await b.client.patch('/users/me', { user_name: 'has spaces' })).status).toBe(400);
        expect((await b.client.patch('/users/me', { email: 'x@y.z' })).status).toBe(400);
    });

    it('404s for unknown users and 400s for malformed ids', async () => {
        const user = await newUser();
        expect((await user.client.get('/users/999999999')).status).toBe(404);
        expect((await user.client.get('/users/abc')).status).toBe(400);
    });
});
