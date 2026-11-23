/** @group api */
import { closeDb, createApiKey, createSound, newUser } from './client';

afterAll(closeDb);

describe('blobs', () => {
    it('stores bytes, content-addressed, and returns a fetchable URL', async () => {
        const user = await newUser();
        const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...Array.from({ length: 64 }, (_, i) => i)]);
        const res = await user.client.post('/blobs', bytes, { 'content-type': 'application/x-npz' });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ content_type: 'application/x-npz', size_bytes: bytes.length });
        const again = await user.client.post('/blobs', bytes, { 'content-type': 'application/x-npz' });
        expect(again.body.url).toBe(res.body.url);

        const fetched = await fetch(res.body.url);
        expect(fetched.status).toBe(200);
        expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(bytes);

        // ...and can be referenced by a blob annotation
        const sound = await createSound(user);
        const annotation = await user.client.post(sound.links.annotations, {
            annotations: [{ schema: 'npz@1', blob: { url: res.body.url, content_type: 'application/x-npz' }, access: '*' }],
        });
        expect(annotation.status).toBe(201);
    });

    it('rejects empty bodies and requires ANNOTATION_EDITOR', async () => {
        const user = await newUser();
        expect((await user.client.post('/blobs', new Uint8Array(), { 'content-type': 'application/x-npz' })).status).toBe(400);
        const key = await createApiKey(user, ['SOUND_READER']);
        expect((await key.post('/blobs', new Uint8Array([1]), { 'content-type': 'application/x-npz' })).status).toBe(403);
    });
});
