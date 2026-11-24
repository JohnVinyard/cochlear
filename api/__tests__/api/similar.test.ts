/** @group api */
import { closeDb, createSound, db, grantRole, newUser, uniqueSuffix } from './client';

afterAll(closeDb);
// a new vector schema's index is built in the background, which takes a while on a big table
jest.setTimeout(90_000);

const vec = (schema: string, vector: number[], extra: Record<string, unknown> = {}) => ({
    schema,
    vector,
    access: '*',
    ...extra,
});

describe('similar annotations', () => {
    it('finds the nearest annotations of the same vector schema, using its own index', async () => {
        const user = await newUser();
        await grantRole(user, 'ANNOTATION_SCHEMA_CREATOR');
        const name = `v-${uniqueSuffix()}`;
        const created = await user.client.post('/annotation-schemas', { name, kind: 'vector', vector_dim: 3 });
        expect(created.status).toBe(201);
        const schema = `${name}@1`;

        // the schema's index is built in the background (it scans the whole annotations table)
        const indexed = async () => {
            for (let i = 0; i < 120; i++) {
                const r = await db().query(
                    `select 1 from pg_class c join pg_index x on x.indexrelid = c.oid
                     where c.relname = $1 and x.indisvalid`,
                    [`annotations_vector_${created.body.id}`]
                );
                if (r.rowCount) return true;
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
            return false;
        };
        expect(await indexed()).toBe(true);

        const [a, b] = [await createSound(user), await createSound(user)];
        const onA = await user.client.post(a.links.annotations, {
            annotations: [
                vec(schema, [1, 0, 0], { start_seconds: 0, duration_seconds: 1 }),
                vec(schema, [0, 1, 0]),
                { schema: 'tags@1', tags: ['x'], access: '*' },
            ],
        });
        const onB = await user.client.post(b.links.annotations, {
            annotations: [vec(schema, [0.9, 0.1, 0]), vec(schema, [-1, 0, 0])],
        });
        const [query, orthogonal, tagged] = onA.body.items;
        const [near, opposite] = onB.body.items;

        const res = await user.client.get(`/annotations/${query.id}/similar?limit=10`);
        expect(res.status).toBe(200);
        expect(res.body.items.map((i: any) => i.annotation.id)).toEqual([query.id, near.id, orthogonal.id, opposite.id]);
        const [first, second] = res.body.items;
        expect(first.distance).toBeCloseTo(0);
        expect(second.distance).toBeCloseTo(1 - 0.9 / Math.hypot(0.9, 0.1));
        expect(second.sound).toMatchObject({ id: b.id, audio_url: b.audio_url, duration_seconds: b.duration_seconds });
        expect(first.annotation).toMatchObject({ start_seconds: 0, duration_seconds: 1 });

        const elsewhere = await user.client.get(`/annotations/${query.id}/similar?limit=1&exclude_same_sound=true`);
        expect(elsewhere.body.items.map((i: any) => i.annotation.id)).toEqual([near.id]);

        expect((await user.client.get(`/annotations/${tagged.id}/similar`)).status).toBe(400);
        expect((await user.client.get(`/annotations/${query.id}/similar?limit=501`)).status).toBe(400);
    });

    it('only finds what the viewer can see', async () => {
        const owner = await newUser();
        await grantRole(owner, 'ANNOTATION_SCHEMA_CREATOR');
        const name = `v-${uniqueSuffix()}`;
        await owner.client.post('/annotation-schemas', { name, kind: 'vector', vector_dim: 2 });
        const sound = await createSound(owner);
        const res = await owner.client.post(sound.links.annotations, {
            annotations: [vec(`${name}@1`, [1, 0]), vec(`${name}@1`, [1, 0.1], { access: null })],
        });
        const [shown, hidden] = res.body.items;
        const other = await newUser();
        const found = await other.client.get(`/annotations/${shown.id}/similar`);
        expect(found.body.items.map((i: any) => i.annotation.id)).toEqual([shown.id]);
        expect((await other.client.get(`/annotations/${hidden.id}/similar`)).status).toBe(404);
    });
});
