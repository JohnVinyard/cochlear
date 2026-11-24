/** @group api */
import { closeDb, createSound, grantRole, newUser, uniqueSuffix } from './client';

afterAll(closeDb);

describe('annotation schemas', () => {
    it('lists the built-in schemas', async () => {
        const user = await newUser();
        const all = await user.client.walk('/annotation-schemas');
        expect(all.map((s) => s.ref)).toEqual(expect.arrayContaining(['tags@1', 'text@1', 'kv@1', 'npz@1', 'chroma-mean@1']));
        const tags = await user.client.get('/annotation-schemas/tags@1');
        expect(tags.body).toMatchObject({ name: 'tags', version: 1, kind: 'tags', vector_dim: null });
        expect((await user.client.get('/annotation-schemas/tags@999')).status).toBe(404);
        expect((await user.client.get('/annotation-schemas/Tags')).status).toBe(400);
    });

    it('may only be created by ANNOTATION_SCHEMA_CREATORs', async () => {
        const user = await newUser();
        const res = await user.client.post('/annotation-schemas', { name: `s-${uniqueSuffix()}`, kind: 'tags' });
        expect(res.status).toBe(403);
    });

    it('creates immutable, versioned schemas owned by their creator', async () => {
        const owner = await newUser();
        const other = await newUser();
        await grantRole(owner, 'ANNOTATION_SCHEMA_CREATOR');
        await grantRole(other, 'ANNOTATION_SCHEMA_CREATOR');
        const name = `mfcc-mean-${uniqueSuffix()}`;
        const v1 = await owner.client.post('/annotation-schemas', { name, kind: 'vector', vector_dim: 13, description: 'mean mfcc' });
        expect(v1.status).toBe(201);
        expect(v1.body).toMatchObject({ ref: `${name}@1`, vector_dim: 13, created_by: owner.id });
        expect(v1.headers.get('location')).toBe(v1.body.links.self);

        const v2 = await owner.client.post('/annotation-schemas', { name, kind: 'vector', vector_dim: 20 });
        expect(v2.body.ref).toBe(`${name}@2`);
        expect((await owner.client.get(`/annotation-schemas/${name}@1`)).body.vector_dim).toBe(13);

        expect((await other.client.post('/annotation-schemas', { name, kind: 'tags' })).status).toBe(403);
    });

    it('validates schemas', async () => {
        const user = await newUser();
        await grantRole(user, 'ANNOTATION_SCHEMA_CREATOR');
        const name = `bad-${uniqueSuffix()}`;
        const bad = [
            { name, kind: 'vector' },
            { name, kind: 'tags', vector_dim: 3 },
            { name, kind: 'vector', vector_dim: 2001 },
            { name, kind: 'nope' },
            { name: 'Upper', kind: 'tags' },
            { name, kind: 'kv', json_schema: { type: 'not-a-type' } },
        ];
        for (const body of bad) {
            expect((await user.client.post('/annotation-schemas', body)).status).toBe(400);
        }
        const good = await user.client.post('/annotation-schemas', {
            name,
            kind: 'kv',
            json_schema: { type: 'object', required: ['confidence'], properties: { confidence: { type: 'number' } } },
        });
        expect(good.status).toBe(201);
    });

    it('count their public, live annotations', async () => {
        const user = await newUser();
        await grantRole(user, 'ANNOTATION_SCHEMA_CREATOR');
        const name = `counted-${uniqueSuffix()}`;
        const created = await user.client.post('/annotation-schemas', { name, kind: 'tags' });
        expect(created.body.annotation_count).toBe(0);
        const sound = await createSound(user);
        const res = await user.client.post(sound.links.annotations, {
            annotations: [
                { schema: `${name}@1`, tags: ['a'], access: '*' },
                { schema: `${name}@1`, tags: ['b'], access: '*' },
                { schema: `${name}@1`, tags: ['private'], access: null }, // not counted
            ],
        });
        const count = async () => (await user.client.get(`/annotation-schemas/${name}@1`)).body.annotation_count;
        expect(await count()).toBe(2);
        await user.client.delete(`/annotations/${res.body.items[0].id}`);
        expect(await count()).toBe(1);
    });
});
