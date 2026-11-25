/** @group api */
import { closeDb, createApiKey, createSound, grantRole, newUser, revokeRole, tags, uniqueSuffix } from './client';

afterAll(closeDb);

const ids = (items: { id: number }[]) => items.map((i) => i.id);

describe('creating annotations', () => {
    it('creates a batch of every kind', async () => {
        const user = await newUser();
        const sound = await createSound(user, { duration_seconds: 30 });
        const res = await user.client.post(sound.links.annotations, {
            annotations: [
                tags(['piano', 'bright']),
                tags(['intro'], '*', { start_seconds: 0, duration_seconds: 4.5 }),
                { schema: 'text@1', text: 'A bright piano piece', access: '*' },
                { schema: 'kv@1', kv: { instrument: 'piano' }, access: '*' },
                { schema: 'chroma-mean@1', vector: Array.from({ length: 12 }, (_, i) => i / 12), access: '*' },
                { schema: 'npz@1', blob: { url: 'https://example.com/f.npz', content_type: 'application/x-npz' }, access: '*' },
            ],
        });
        expect(res.status).toBe(201);
        const [t, seg, text, kv, vec, blob] = res.body.items;
        expect(t).toMatchObject({ schema: 'tags@1', kind: 'tags', tags: ['piano', 'bright'], start_seconds: null, sound_id: sound.id });
        expect(seg).toMatchObject({ start_seconds: 0, duration_seconds: 4.5, end_seconds: 4.5 });
        expect(text.text).toBe('A bright piano piece');
        expect(kv.kv).toEqual({ instrument: 'piano' });
        expect(vec.vector).toHaveLength(12);
        expect(vec.vector[6]).toBeCloseTo(0.5);
        expect(blob.blob).toEqual({ url: 'https://example.com/f.npz', content_type: 'application/x-npz' });
        expect(ids(res.body.items)).toEqual([...ids(res.body.items)].sort((a, b) => a - b));

        const fetched = await user.client.get(t.links.self);
        expect(fetched.body).toEqual(t);
        expect((await user.client.get(t.links.schema)).body.ref).toBe('tags@1');
        expect((await user.client.get(t.links.sound)).body.id).toBe(sound.id);
    });

    it('is atomic, reporting every invalid item', async () => {
        const user = await newUser();
        const sound = await createSound(user, { duration_seconds: 10 });
        const res = await user.client.post(sound.links.annotations, {
            annotations: [
                tags(['ok']),
                tags(['late'], '*', { start_seconds: 9, duration_seconds: 5 }),
                { schema: 'tags@1', text: 'wrong kind', access: '*' },
                { schema: 'chroma-mean@1', vector: [1, 2, 3], access: '*' },
            ],
        });
        expect(res.status).toBe(400);
        expect(res.body.errors).toEqual([
            expect.stringMatching(/^annotations\[1\]: segment ends/),
            expect.stringMatching(/^annotations\[2\]: .*unexpected field/),
            expect.stringMatching(/^annotations\[2\]: tags must be/),
            expect.stringMatching(/^annotations\[3\]: vector must have exactly 12/),
        ]);
        expect(await user.client.walk(sound.links.annotations)).toHaveLength(0);
    });

    it('rejects unknown schemas, missing access, oversized batches and unknown sounds', async () => {
        const user = await newUser();
        const sound = await createSound(user);
        const post = (body: unknown) => user.client.post(sound.links.annotations, body);
        expect((await post({ annotations: [{ schema: 'nope@1', tags: ['x'], access: '*' }] })).status).toBe(400);
        expect((await post({ annotations: [{ schema: 'tags@1', tags: ['x'] }] })).status).toBe(400);
        expect((await post({ annotations: [] })).status).toBe(400);
        expect((await post({ annotations: Array.from({ length: 501 }, () => tags(['x'])) })).status).toBe(400);
        expect((await post({ annotations: [tags(['x'], [999999999])] })).status).toBe(400);
        expect((await user.client.post('/sounds/999999999/annotations', { annotations: [tags(['x'])] })).status).toBe(404);
    });

    it("validates data against the schema's json_schema", async () => {
        const user = await newUser();
        await grantRole(user, 'ANNOTATION_SCHEMA_CREATOR');
        const schema = await user.client.post('/annotation-schemas', {
            name: `scored-tags-${uniqueSuffix()}`,
            kind: 'tags',
            json_schema: { type: 'object', required: ['confidence'], properties: { confidence: { type: 'number', maximum: 1 } } },
        });
        const sound = await createSound(user);
        const post = (data: unknown) =>
            user.client.post(sound.links.annotations, { annotations: [tags(['x'], '*', { schema: schema.body.ref, data })] });
        expect((await post({ confidence: 2 })).status).toBe(400);
        expect((await post(undefined)).status).toBe(400);
        const ok = await post({ confidence: 0.9 });
        expect(ok.status).toBe(201);
        expect(ok.body.items[0].data).toEqual({ confidence: 0.9 });
    });

    it('cannot annotate a deleted sound', async () => {
        const user = await newUser();
        const sound = await createSound(user);
        await user.client.delete(sound.links.self);
        expect((await user.client.post(sound.links.annotations, { annotations: [tags(['x'])] })).status).toBe(410);
    });

    it('requires ANNOTATION_EDITOR', async () => {
        const user = await newUser();
        const sound = await createSound(user);
        const key = await createApiKey(user, ['ANNOTATION_READER']);
        expect((await key.post(sound.links.annotations, { annotations: [tags(['x'])] })).status).toBe(403);
        await revokeRole(user, 'ANNOTATION_EDITOR');
        expect((await user.client.post(sound.links.annotations, { annotations: [tags(['x'])] })).status).toBe(403);
    });
});

describe('annotation access', () => {
    it('is private by default (null), public with "*", or shared with listed users', async () => {
        const owner = await newUser();
        const friend = await newUser();
        const stranger = await newUser();
        const sound = await createSound(owner);
        const res = await owner.client.post(sound.links.annotations, {
            annotations: [tags(['private'], null), tags(['public'], '*'), tags(['shared'], [friend.id, owner.id])],
        });
        const [priv, pub, shared] = res.body.items;
        expect([priv.access, pub.access, shared.access]).toEqual([null, '*', [friend.id]]);

        // single resources
        expect((await friend.client.get(priv.links.self)).status).toBe(404);
        expect((await friend.client.get(pub.links.self)).status).toBe(200);
        expect((await friend.client.get(shared.links.self)).status).toBe(200);
        expect((await stranger.client.get(shared.links.self)).status).toBe(404);
        // access lists are the creator's business
        expect((await friend.client.get(shared.links.self)).body).not.toHaveProperty('access');

        // ...and all three feeds
        const visible = async (client: typeof owner.client) => ({
            sound: ids(await client.walk(sound.links.annotations)),
            user: ids(await client.walk(`/users/${owner.id}/annotations`)),
            all: ids(await client.walk(`/annotations?created_by=${owner.id}`)),
        });
        const expectFeeds = async (client: typeof owner.client, expected: number[]) => {
            const v = await visible(client);
            expect(v).toEqual({ sound: expected, user: expected, all: expected });
        };
        await expectFeeds(owner.client, [priv.id, pub.id, shared.id]);
        await expectFeeds(friend.client, [pub.id, shared.id]);
        await expectFeeds(stranger.client, [pub.id]);
    });
});

describe('annotation feeds', () => {
    it('filters by schema, kind, tags and time range', async () => {
        const user = await newUser();
        const sound = await createSound(user, { duration_seconds: 60 });
        const res = await user.client.post(sound.links.annotations, {
            annotations: [
                tags(['piano', 'bright']),
                tags(['piano'], '*', { start_seconds: 0, duration_seconds: 10 }),
                tags(['drums'], '*', { start_seconds: 20, duration_seconds: 10 }),
                { schema: 'text@1', text: 'hello', access: '*' },
            ],
        });
        const [whole, early, late, text] = ids(res.body.items);
        const feed = (q: string) => user.client.walk(`${sound.links.annotations.href}?${q}`).then(ids);
        expect(await feed('schema=text@1')).toEqual([text]);
        expect(await feed('kind=text')).toEqual([text]);
        expect(await feed('kind=tags&tags=drums')).toEqual([late]);
        expect(await feed('kind=blob')).toEqual([]);
        expect((await user.client.get(`${sound.links.annotations.href}?kind=nope`)).status).toBe(400);
        expect(await feed('tags=piano')).toEqual([whole, early]);
        expect(await feed('tags=piano,bright')).toEqual([whole]);
        // whole-sound annotations apply to every time range
        expect(await feed('time_range=25-26')).toEqual([whole, late, text]);
        expect(await feed('time_range=5-21')).toEqual([whole, early, late, text]);
        expect((await user.client.get(`${sound.links.annotations.href}?time_range=5-1`)).status).toBe(400);
        expect((await user.client.get(`/annotations?time_range=1-2`)).status).toBe(400);
        expect((await user.client.get(`/annotations?schema=nope@1`)).status).toBe(400);
    });

    it('pages with next links', async () => {
        const user = await newUser();
        const sound = await createSound(user);
        const res = await user.client.post(sound.links.annotations, {
            annotations: Array.from({ length: 7 }, (_, i) => tags([`t${i}`])),
        });
        const all = await user.client.walk(`${sound.links.annotations.href}?page_size=3`);
        expect(ids(all)).toEqual(ids(res.body.items));
    });

    it('keeps ids in commit order under concurrent writers', async () => {
        const user = await newUser();
        const sound = await createSound(user);
        const before = await user.client.get(`/users/${user.id}/annotations`);
        expect(before.body.items).toEqual([]);
        const batches = await Promise.all(
            Array.from({ length: 10 }, (_, i) =>
                user.client.post(sound.links.annotations, { annotations: Array.from({ length: 20 }, () => tags([`b${i}`])) })
            )
        );
        expect(batches.every((b) => b.status === 201)).toBe(true);
        const created = batches.flatMap((b) => ids(b.body.items)).sort((a, b) => a - b);
        const seen = ids(await user.client.walk(`/users/${user.id}/annotations?page_size=33`));
        expect(seen).toEqual(created);
        // every batch's ids are contiguous, because inserts are serialized
        for (const b of batches) {
            const batchIds = ids(b.body.items);
            expect(batchIds[batchIds.length - 1]! - batchIds[0]!).toBe(batchIds.length - 1);
        }
    });
});

describe('deleting annotations', () => {
    it('only by the creator;  afterwards gone from GETs and feeds', async () => {
        const owner = await newUser();
        const other = await newUser();
        const sound = await createSound(owner);
        const res = await owner.client.post(sound.links.annotations, { annotations: [tags(['a']), tags(['b'])] });
        const [a, b] = res.body.items;
        expect((await other.client.delete(a.links.self)).status).toBe(403);
        expect((await owner.client.delete(a.links.self)).status).toBe(204);
        expect((await owner.client.get(a.links.self)).status).toBe(410);
        expect((await owner.client.delete(a.links.self)).status).toBe(410);
        expect(ids(await other.client.walk(sound.links.annotations))).toEqual([b.id]);
    });

    it("disappear with their sound", async () => {
        const owner = await newUser();
        const sound = await createSound(owner);
        await owner.client.post(sound.links.annotations, { annotations: [tags(['a'])] });
        await owner.client.delete(sound.links.self);
        expect((await owner.client.get(sound.links.annotations)).status).toBe(410);
        expect(await owner.client.walk(`/users/${owner.id}/annotations`)).toEqual([]);
    });
});
