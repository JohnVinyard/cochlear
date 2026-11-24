/** @group api */
import { closeDb, createSound, newUser, revokeRole, soundBody } from './client';

afterAll(closeDb);

describe('sounds', () => {
    it('creates and fetches a sound', async () => {
        const user = await newUser();
        const body = soundBody({ info_url: 'https://example.com/info' });
        const created = await user.client.post('/sounds', body);
        expect(created.status).toBe(201);
        expect(created.headers.get('location')).toBe(created.body.links.self);
        expect(created.body).toMatchObject({ ...body, created_by: user.id, formats: [] });

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

    describe('formats', () => {
        const mp3 = (n = 1) => ({
            url: `https://example.com/preview-${n}.mp3`,
            mime_type: 'Audio/MPEG',
            metadata: { bitrate: 128000, sample_rate: 44100, channels: 2 },
        });

        it('can be registered with the sound, and are embedded in it', async () => {
            const user = await newUser();
            const created = await user.client.post('/sounds', soundBody({ formats: [mp3()] }));
            expect(created.status).toBe(201);
            const [format] = created.body.formats;
            expect(format).toMatchObject({
                sound_id: created.body.id,
                url: mp3().url,
                mime_type: 'audio/mpeg', // normalised
                metadata: mp3().metadata,
                created_by: user.id,
            });
            expect(format.links.self).toMatch(new RegExp(`/sounds/${created.body.id}/formats/${format.id}$`));
            expect((await user.client.get(created.body.links.formats)).body.items).toEqual([format]);
            expect((await user.client.get(format.links.self)).body).toEqual(format);
            // and in the feed
            const page = await user.client.get(`/users/${user.id}/sounds`);
            expect(page.body.items[0].formats).toEqual([format]);
        });

        it('can be added later, by anyone who may edit sounds, and deleted only by their creator', async () => {
            const [owner, bot] = [await newUser(), await newUser()];
            const sound = await createSound(owner);
            const sprs = {
                url: 'https://example.com/encoded.sprs',
                mime_type: 'audio/vnd.cochlea.sprs+json',
                metadata: { version: '0.2', requires: { 'org.cochlea.gammatone': '0.1' } },
            };
            const added = await bot.client.post(sound.links.formats, sprs);
            expect(added.status).toBe(201);
            expect(added.headers.get('location')).toBe(added.body.links.self);
            expect(added.body).toMatchObject({ ...sprs, created_by: bot.id });

            const dupe = await owner.client.post(sound.links.formats, { ...sprs, metadata: {} });
            expect(dupe.status).toBe(409);
            expect(dupe.headers.get('location')).toBe(added.body.links.self);

            expect((await owner.client.delete(added.body.links.self)).status).toBe(403);
            expect((await bot.client.delete(added.body.links.self)).status).toBe(204);
            expect((await bot.client.get(added.body.links.self)).status).toBe(410);
            expect((await owner.client.get(sound.links.self)).body.formats).toEqual([]);
            // once deleted, the URL can be registered again
            expect((await owner.client.post(sound.links.formats, sprs)).status).toBe(201);
        });

        it("aren't reachable through another sound", async () => {
            const user = await newUser();
            const [a, b] = [await createSound(user, { formats: [mp3()] }), await createSound(user)];
            const format = a.formats[0];
            expect((await user.client.get(`/sounds/${b.id}/formats/${format.id}`)).status).toBe(404);
            expect((await user.client.delete(`/sounds/${b.id}/formats/${format.id}`)).status).toBe(404);
        });

        it('validate their input', async () => {
            const user = await newUser();
            const sound = await createSound(user);
            for (const bad of [
                { ...mp3(), url: 'ftp://example.com/a.mp3' },
                { ...mp3(), mime_type: 'mp3' },
                { ...mp3(), mime_type: 'audio/mpeg; bitrate=128' },
                { ...mp3(), metadata: [1, 2] },
                { ...mp3(), metadata: { big: 'x'.repeat(17_000) } },
                { url: 'https://example.com/a.mp3' },
            ]) {
                expect((await user.client.post(sound.links.formats, bad)).status).toBe(400);
            }
            const twice = await user.client.post('/sounds', soundBody({ formats: [mp3(), mp3()] }));
            expect(twice.status).toBe(400);
        });

        it('belong to live sounds only', async () => {
            const user = await newUser();
            const sound = await createSound(user);
            await user.client.delete(sound.links.self);
            expect((await user.client.post(sound.links.formats, mp3())).status).toBe(410);
            expect((await user.client.get(sound.links.formats)).status).toBe(410);
        });
    });
});
