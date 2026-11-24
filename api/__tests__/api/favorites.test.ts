/** @group api */
import { closeDb, createSound, newUser } from './client';

afterAll(closeDb);

/** Favorites are private favorite@1 annotations: no endpoints of their own */
const star = (segment: { start_seconds: number; duration_seconds: number } | null = null) => ({
    schema: 'favorite@1',
    tags: ['favorite'],
    access: null,
    ...(segment ?? {}),
});

describe('favorites', () => {
    it('are private annotations, listed by schema and creator, and unstarred by deleting them', async () => {
        const [me, other] = [await newUser(), await newUser()];
        const sound = await createSound(me, { duration_seconds: 60 });
        const res = await me.client.post(sound.links.annotations, {
            annotations: [star(), star({ start_seconds: 10, duration_seconds: 2.5 })],
        });
        expect(res.status).toBe(201);
        const [whole, segment] = res.body.items;
        expect(whole.access).toBeNull();

        const mine = (user = me) => user.client.walk(`/annotations?schema=favorite@1&created_by=${me.id}`);
        expect((await mine()).map((a: { id: number }) => a.id)).toEqual([whole.id, segment.id]);
        expect(await mine(other)).toEqual([]); // nobody else sees them
        expect((await other.client.get(`/annotations/${whole.id}`)).status).toBe(404);

        // "favorite" in tags@1 is just a tag, not a favorite
        await me.client.post(sound.links.annotations, { annotations: [{ schema: 'tags@1', tags: ['favorite'], access: '*' }] });
        expect(await mine()).toHaveLength(2);

        expect((await me.client.delete(`/annotations/${segment.id}`)).status).toBe(204);
        expect((await mine()).map((a: { id: number }) => a.id)).toEqual([whole.id]);
    });
});
