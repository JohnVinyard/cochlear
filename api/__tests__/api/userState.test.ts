/** @group api */
import { closeDb, createApiKey, newUser } from './client';

afterAll(closeDb);

describe('user state documents', () => {
    it('start as {}, and are replaced by PUT', async () => {
        const user = await newUser();
        const empty = await user.client.get('/users/me/state');
        expect(empty.status).toBe(200);
        expect(empty.body).toEqual({});
        expect(empty.headers.get('etag')).toBe('"0"');

        const put = await user.client.request('PUT', '/users/me/state', { cursor: 41, nested: { a: [1] } });
        expect(put.status).toBe(200);
        expect(put.headers.get('etag')).toBe('"1"');
        expect((await user.client.get('/users/me/state')).body).toEqual({ cursor: 41, nested: { a: [1] } });
        expect((await user.client.get('/users/me')).body.links.state).toMatch(/\/users\/me\/state$/);
    });

    it('are written conditionally with If-Match', async () => {
        const user = await newUser();
        const first = await user.client.request('PUT', '/users/me/state', { cursor: 1 });
        const etag = first.headers.get('etag')!;
        const second = await user.client.request('PUT', '/users/me/state', { cursor: 2 }, { 'if-match': etag });
        expect(second.status).toBe(200);

        const stale = await user.client.request('PUT', '/users/me/state', { cursor: 99 }, { 'if-match': etag });
        expect(stale.status).toBe(412);
        expect((await user.client.get('/users/me/state')).body).toEqual({ cursor: 2 });

        const bad = await user.client.request('PUT', '/users/me/state', { cursor: 3 }, { 'if-match': 'nope' });
        expect(bad.status).toBe(400);
    });

    it('must be JSON objects of at most 64 KB', async () => {
        const user = await newUser();
        expect((await user.client.request('PUT', '/users/me/state', [1, 2])).status).toBe(400);
        expect((await user.client.request('PUT', '/users/me/state', { x: 'y'.repeat(70_000) })).status).toBe(400);
    });

    it('are usable with any API key, and private to their user', async () => {
        const bot = await newUser('bot');
        const key = await createApiKey(bot, ['SOUND_READER']);
        expect((await key.request('PUT', '/users/me/state', { cursor: 7 })).status).toBe(200);
        expect((await bot.client.get('/users/me/state')).body).toEqual({ cursor: 7 });
        const other = await newUser();
        expect((await other.client.get('/users/me/state')).body).toEqual({});
    });
});
