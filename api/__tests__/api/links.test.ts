/** @group api */
/**
 * Links say what the requester can do next (docs/links.md). These tests
 * mirror the permission tests from the client's side: when a link is there,
 * following it works (with a body that matches the schema it points to),
 * and when it isn't, the request it would have made is refused.
 */
import type { Link, Links } from '@cochlea/shared';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import {
    closeDb,
    createApiKey,
    createSound,
    grantRole,
    newUser,
    revokeRole,
    soundBody,
    tags,
    TestClient,
    uniqueSuffix,
} from './client';

afterAll(closeDb);
jest.setTimeout(30_000);

const validators = new Map<string, ValidateFunction>();

/** What a client building a form would do: fetch the schema (no credentials needed) and compile it */
const validatorFor = async (schemaUrl: string): Promise<ValidateFunction> => {
    let validate = validators.get(schemaUrl);
    if (!validate) {
        const res = await TestClient.anonymous().get(schemaUrl);
        expect(res.status).toBe(200);
        expect(res.body.$id).toBe(schemaUrl);
        const ajv = new Ajv({ allErrors: true });
        addFormats(ajv);
        validate = ajv.compile(res.body);
        validators.set(schemaUrl, validate);
    }
    return validate;
};

/** Follows a link, having checked that `body` matches the link's schema */
const act = async (client: TestClient, link: Link | undefined, body?: unknown, headers?: Record<string, string>) => {
    expect(link).toBeDefined();
    if (link!.schema) {
        const validate = await validatorFor(link!.schema);
        validate(body);
        expect(validate.errors ?? []).toEqual([]);
    }
    return client.follow(link, body, headers);
};

const rels = (links: Links) => Object.keys(links).sort();

const mp3 = () => ({ url: `https://example.com/${uniqueSuffix()}.mp3`, mime_type: 'audio/mpeg' });

describe('links', () => {
    describe('the entry point', () => {
        it('links to what a new user can do', async () => {
            const user = await newUser();
            const root = (await user.client.get('/')).body;
            expect(rels(root.links)).toEqual(
                [
                    'self',
                    'me',
                    'openapi',
                    'sounds',
                    'create_sound',
                    'annotations',
                    'annotation_schemas',
                    'api_keys',
                    'create_api_key',
                    'upload_blob',
                ].sort()
            );
            expect(root.links.create_sound).toMatchObject({
                method: 'POST',
                href: expect.stringMatching(/\/v1\/sounds$/),
                schema: expect.stringMatching(/\/v1\/schemas\/CreateSoundRequestBody$/),
            });
            expect((await act(user.client, root.links.create_sound, soundBody())).status).toBe(201);
            const blob = await act(user.client, root.links.upload_blob, new Uint8Array([1, 2, 3]), {
                'content-type': 'application/octet-stream',
            });
            expect(blob.status).toBe(201);
        });

        it('links to creating schemas only for schema creators', async () => {
            const user = await newUser();
            expect((await user.client.get('/')).body.links).not.toHaveProperty('create_annotation_schema');
            expect((await user.client.post('/annotation-schemas', { name: `s-${uniqueSuffix()}`, kind: 'tags' })).status).toBe(403);

            await grantRole(user, 'ANNOTATION_SCHEMA_CREATOR');
            const { links } = (await user.client.get('/')).body;
            const created = await act(user.client, links.create_annotation_schema, { name: `s-${uniqueSuffix()}`, kind: 'tags' });
            expect(created.status).toBe(201);
        });

        it("doesn't link to what an API key can't do", async () => {
            const user = await newUser();
            const key = await createApiKey(user, ['SOUND_READER']);
            const { links } = (await key.get('/')).body;
            expect(rels(links)).toEqual(['me', 'openapi', 'self', 'sounds']);
            expect((await key.get('/annotations')).status).toBe(403);
            expect((await key.get('/api-keys')).status).toBe(403);
            expect((await key.post('/sounds', soundBody())).status).toBe(403);
        });
    });

    describe('every GET link', () => {
        // a breadth-first walk from the entry point, over each response's own
        // links and its first item's
        const crawl = async (client: TestClient) => {
            const root = (await client.get('/')).body.links.self.href as string;
            const queue: string[] = [root];
            const seen = new Set(queue);
            const failures: string[] = [];
            while (queue.length && seen.size < 80) {
                const href = queue.shift()!;
                const res = await client.get(href);
                if (res.status !== 200) failures.push(`${res.status} ${href}`);
                const body = res.body ?? {};
                for (const links of [body.links, body.items?.[0]?.links, body.items?.[0]?.annotation?.links]) {
                    for (const link of Object.values<Link>(links ?? {})) {
                        if (link.method === 'GET' && link.href.startsWith(root) && !seen.has(link.href)) {
                            seen.add(link.href);
                            queue.push(link.href);
                        }
                    }
                }
            }
            return { failures, seen };
        };

        it('leads somewhere a user may go', async () => {
            const user = await newUser();
            const sound = await createSound(user, { formats: [mp3()] });
            await user.client.follow(sound.links.create_annotations, { annotations: [tags(['x'])] });
            await createApiKey(user, ['SOUND_READER']);
            const { failures, seen } = await crawl(user.client);
            expect(failures).toEqual([]);
            expect(seen.size).toBeGreaterThan(15);
        });

        it('leads somewhere an API key may go', async () => {
            const user = await newUser();
            await createSound(user);
            const key = await createApiKey(user, ['SOUND_READER']);
            const { failures } = await crawl(key);
            expect(failures).toEqual([]);
        });
    });

    describe('schemas', () => {
        it('are served without credentials, and are what requests are validated against', async () => {
            const user = await newUser();
            const me = (await user.client.get('/users/me')).body;
            const url = me.links.update.schema;
            const validate = await validatorFor(url);
            expect(validate({ about_me: 'hi' })).toBe(true);
            expect(validate({ bogus: 1 })).toBe(false);
            expect((await user.client.patch('/users/me', { bogus: 1 })).status).toBe(400);

            const res = await TestClient.anonymous().get(url);
            expect(res.headers.get('cache-control')).toContain('public');
            expect((await TestClient.anonymous().get('/schemas/Nope')).status).toBe(404);
            expect((await TestClient.anonymous().get('/schemas/constructor')).status).toBe(404);
        });
    });

    describe('a sound', () => {
        it('links to annotating it and adding formats for anyone, and deleting it for its creator', async () => {
            const owner = await newUser();
            const other = await newUser();
            const sound = await createSound(owner);

            const theirs = (await other.client.get(sound.links.self)).body;
            expect(rels(theirs.links)).toEqual(
                ['add_format', 'annotations', 'audio', 'create_annotations', 'created_by', 'formats', 'self'].sort()
            );
            expect(theirs.links.create_annotations).toMatchObject({
                method: 'POST',
                href: sound.links.annotations.href,
                schema: expect.stringMatching(/\/schemas\/CreateAnnotationsRequestBody$/),
            });
            expect((await act(other.client, theirs.links.create_annotations, { annotations: [tags(['x'])] })).status).toBe(201);
            expect((await act(other.client, theirs.links.add_format, mp3())).status).toBe(201);
            expect((await other.client.delete(sound.links.self)).status).toBe(403);

            const mine = (await owner.client.get(sound.links.self)).body;
            expect(mine.links.delete).toEqual({ method: 'DELETE', href: sound.links.self.href });
            expect((await act(owner.client, mine.links.delete)).status).toBe(204);
        });

        it("doesn't link to what the requester's roles don't allow", async () => {
            const user = await newUser();
            const sound = await createSound(user);
            await revokeRole(user, 'ANNOTATION_EDITOR');
            await revokeRole(user, 'ANNOTATION_READER');
            await revokeRole(user, 'SOUND_EDITOR');

            const { links } = (await user.client.get(sound.links.self)).body;
            expect(rels(links)).toEqual(['audio', 'created_by', 'formats', 'self']);
            expect((await user.client.post(sound.links.annotations, { annotations: [tags(['x'])] })).status).toBe(403);
            expect((await user.client.get(sound.links.annotations)).status).toBe(403);
            expect((await user.client.post(sound.links.formats, mp3())).status).toBe(403);
            expect((await user.client.delete(sound.links.self)).status).toBe(403);
            // nor in feeds, or at the entry point
            expect((await user.client.get('/sounds')).body.links).not.toHaveProperty('create');
            expect((await user.client.get('/')).body.links).not.toHaveProperty('create_sound');
        });

        it('has formats, which link to deleting them for their creator', async () => {
            const owner = await newUser();
            const other = await newUser();
            const sound = await createSound(owner);
            const formats = (await other.client.get(sound.links.formats)).body;
            expect(formats.links.create.schema).toMatch(/\/schemas\/CreateSoundFormatRequestBody$/);
            const format = (await act(other.client, formats.links.create, mp3())).body;
            expect(format.links.delete).toBeDefined();

            const seenByOwner = (await owner.client.get(format.links.self)).body;
            expect(seenByOwner.links).not.toHaveProperty('delete');
            expect((await owner.client.delete(format.links.self)).status).toBe(403);
            expect((await act(other.client, format.links.delete)).status).toBe(204);
        });
    });

    describe('feeds', () => {
        it('link to creating what they list', async () => {
            const user = await newUser();
            const sounds = (await user.client.get('/sounds?page_size=1')).body;
            expect(sounds.links.self.href).toContain('page_size=1');
            const sound = (await act(user.client, sounds.links.create, soundBody())).body;

            const annotations = (await user.client.get(sound.links.annotations)).body;
            expect((await act(user.client, annotations.links.create, { annotations: [tags(['x'])] })).status).toBe(201);
            // annotations are always of a sound
            expect((await user.client.get('/annotations')).body.links).not.toHaveProperty('create');

            expect((await user.client.get('/annotation-schemas')).body.links).not.toHaveProperty('create');
            await grantRole(user, 'ANNOTATION_SCHEMA_CREATOR');
            const schemas = (await user.client.get('/annotation-schemas')).body;
            expect((await act(user.client, schemas.links.create, { name: `s-${uniqueSuffix()}`, kind: 'text' })).status).toBe(201);
        });
    });

    describe('an annotation', () => {
        it('links to deleting it for its creator only', async () => {
            const owner = await newUser();
            const other = await newUser();
            const sound = await createSound(owner);
            const [created] = (await owner.client.follow(sound.links.create_annotations, { annotations: [tags(['x'])] })).body.items;
            expect(rels(created.links)).toEqual(['created_by', 'delete', 'schema', 'self', 'sound']);

            const seenByOther = (await other.client.get(created.links.self)).body;
            expect(seenByOther.links).not.toHaveProperty('delete');
            expect((await other.client.delete(created.links.self)).status).toBe(403);
            expect((await act(owner.client, created.links.delete)).status).toBe(204);
        });

        it('links to similar annotations only if it is a vector', async () => {
            const user = await newUser();
            await grantRole(user, 'ANNOTATION_SCHEMA_CREATOR');
            const name = `v-${uniqueSuffix()}`;
            expect((await user.client.post('/annotation-schemas', { name, kind: 'vector', vector_dim: 2 })).status).toBe(201);
            const sound = await createSound(user);
            const [vector, tagged] = (
                await user.client.follow(sound.links.create_annotations, {
                    annotations: [{ schema: `${name}@1`, vector: [1, 0], access: '*' }, tags(['x'])],
                })
            ).body.items;
            expect(tagged.links).not.toHaveProperty('similar');
            const similar = await act(user.client, vector.links.similar);
            expect(similar.status).toBe(200);
            expect(similar.body.items[0].annotation.id).toBe(vector.id);
        });
    });

    describe('a user', () => {
        it('links to editing your own profile and state, and managing your keys', async () => {
            const user = await newUser();
            const other = await newUser();
            const me = (await user.client.get('/users/me')).body;
            expect(rels(me.links)).toEqual(
                ['annotations', 'api_keys', 'create_api_key', 'self', 'sounds', 'state', 'update', 'update_state'].sort()
            );
            expect(me.links.update).toMatchObject({ method: 'PATCH', schema: expect.stringMatching(/UpdateMeRequestBody$/) });
            expect(me.links.update_state).toMatchObject({ method: 'PUT', href: me.links.state.href });

            expect((await act(user.client, me.links.update, { about_me: 'hello' })).body.about_me).toBe('hello');
            expect((await act(user.client, me.links.update_state, { cursor: 1 })).status).toBe(200);
            const key = await act(user.client, me.links.create_api_key, { name: 'bot', roles: ['SOUND_READER'] });
            expect(key.status).toBe(201);
            expect((await user.client.get(key.body.links.self)).body.name).toBe('bot');

            const theirs = (await user.client.get(`/users/${other.id}`)).body;
            expect(rels(theirs.links)).toEqual(['annotations', 'self', 'sounds']);
        });

        it('links an API key to its profile, but not to managing keys', async () => {
            const user = await newUser();
            const key = await createApiKey(user, ['SOUND_READER', 'ANNOTATION_READER']);
            const me = (await key.get('/users/me')).body;
            expect(rels(me.links)).toEqual(['annotations', 'self', 'sounds', 'state', 'update', 'update_state'].sort());
            expect((await key.get('/api-keys')).status).toBe(403);
            expect((await key.post('/api-keys', { name: 'x', roles: ['SOUND_READER'] })).status).toBe(403);
        });
    });

    describe('api keys', () => {
        it('link to creating and deleting them', async () => {
            const user = await newUser();
            const list = (await user.client.get('/api-keys')).body;
            const created = (await act(user.client, list.links.create, { name: 'bot', roles: ['SOUND_READER'] })).body;
            expect((await act(user.client, created.links.delete)).status).toBe(204);
            expect((await user.client.get(created.links.self)).status).toBe(404);
        });
    });
});
