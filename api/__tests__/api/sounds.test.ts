/** @group api */
import { closeDb, createSound, newUser, revokeRole, soundBody } from './client';

afterAll(closeDb);

describe('sounds', () => {
    it('creates and fetches a sound', async () => {
        const user = await newUser();
        const body = soundBody({ info_url: 'https://example.com/info', low_quality_audio_url: 'https://example.com/a.mp3' });
        const created = await user.client.post('/sounds', body);
        expect(created.status).toBe(201);
        expect(created.headers.get('location')).toBe(created.body.links.self);
        expect(created.body).toMatchObject({ ...body, created_by: user.id });

        const fetched = await user.client.get(created.body.links.self);
        expect(fetched.status).toBe(200);
        expect(fetched.body).toEqual(created.body);
        expect(fetched.body.links).toMatchObject({
            annotations: expect.stringMatching(/\/v1\/sounds\/\d+\/annotations$/),
            created_by: expect.stringMatching(/\/v1\/users\/\d+$/),
            audio: body.audio_url,
        });
    });

    it('is unique by audio_url;  a duplicate points at the original', async () => {
        const user = await newUser();
        const other = await newUser();
        const original = await createSound(user);
        const dupe = await other.client.post('/sounds', soundBody({ audio_url: original.audio_url }));
        expect(dupe.status).toBe(409);
        expect(dupe.headers.get('location')).toBe(original.links.self);
    });

    it('validates input', async () => {
        const user = await newUser();
        const bad = [
            soundBody({ audio_url: 'not a url' }),
            soundBody({ audio_url: 'ftp://example.com/a.wav' }),
            soundBody({ duration_seconds: 0 }),
            soundBody({ license_type: 'all rights reserved' }),
            soundBody({ extra: true }),
        ];
        for (const body of bad) {
            expect((await user.client.post('/sounds', body)).status).toBe(400);
        }
        expect((await user.client.post('/sounds', '{oops', { 'content-type': 'application/json' })).status).toBe(400);
    });

    it('requires SOUND_EDITOR to create, SOUND_READER to read', async () => {
        const user = await newUser();
        const sound = await createSound(user);
        await revokeRole(user, 'SOUND_EDITOR');
        expect((await user.client.post('/sounds', soundBody())).status).toBe(403);
        await revokeRole(user, 'SOUND_READER');
        expect((await user.client.get(sound.links.self)).status).toBe(403);
    });

    it('can be deleted only by its creator, and is then gone', async () => {
        const user = await newUser();
        const other = await newUser();
        const sound = await createSound(user);
        expect((await other.client.delete(sound.links.self)).status).toBe(403);
        expect((await user.client.delete(sound.links.self)).status).toBe(204);
        expect((await user.client.get(sound.links.self)).status).toBe(410);
        expect((await user.client.get('/sounds/999999999')).status).toBe(404);
        const feed = await user.client.walk(`/users/${user.id}/sounds`);
        expect(feed).toHaveLength(0);
    });

    it('is a feed, oldest first, paged via next links', async () => {
        const user = await newUser();
        const created = [];
        for (let i = 0; i < 5; i++) created.push(await createSound(user));

        const first = await user.client.get(`/sounds?created_by=${user.id}&page_size=2`);
        expect(first.body.items.map((s: any) => s.id)).toEqual(created.slice(0, 2).map((s) => s.id));
        expect(first.body.next).toContain('low_id=');

        const all = await user.client.walk(`/sounds?created_by=${user.id}&page_size=2`);
        expect(all.map((s) => s.id)).toEqual(created.map((s) => s.id));

        // polling from the last seen id yields nothing new, and no next link
        const tail = await user.client.get(`/users/${user.id}/sounds?low_id=${created[4].id}`);
        expect(tail.body.items).toEqual([]);
        expect(tail.body).not.toHaveProperty('next');
    });

    it('validates feed parameters', async () => {
        const user = await newUser();
        expect((await user.client.get('/sounds?page_size=501')).status).toBe(400);
        expect((await user.client.get('/sounds?page_size=0')).status).toBe(400);
        expect((await user.client.get('/sounds?low_id=abc')).status).toBe(400);
        expect((await user.client.get('/sounds?bogus=1')).status).toBe(400);
        expect((await user.client.get('/sounds?page_size=500')).status).toBe(200);
    });
});
