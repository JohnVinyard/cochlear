/** @group api */
import { closeDb, createSound, newUser, uniqueSuffix } from './client';

afterAll(closeDb);

/** A made-up word, unique to this run, so results don't depend on what else is in the database */
const word = () => `zz${uniqueSuffix().replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]!)}`;

const ids = (items: { id: number }[]) => items.map((i) => i.id);

describe('full-text search (q)', () => {
    it('searches tags, prose and the string values of JSON, but not keys or numbers', async () => {
        const user = await newUser();
        const sound = await createSound(user);
        const [w, other] = [word(), word()];
        const res = await user.client.post(sound.links.annotations, {
            annotations: [
                { schema: 'tags@1', tags: [`${w}-tag`, 'bright'], access: '*' },
                { schema: 'text@1', text: `A slow, sad cello melody about ${w}`, access: '*' },
                { schema: 'kv@1', kv: { instrument_name: `${w} Cello`, note: 60, [other]: 'x' }, access: '*' },
                { schema: 'tags@1', tags: [other], access: '*' },
            ],
        });
        const [tagged, prose, json, unrelated] = ids(res.body.items);
        const search = (q: string) =>
            user.client.walk(`${sound.links.annotations}?q=${encodeURIComponent(q)}`).then(ids);

        expect(await search(w)).toEqual([tagged, prose, json]); // a hyphenated tag is indexed in parts...
        expect(await search(`${w}-tag`)).toEqual([tagged]); // ...and whole
        expect(await search('melodies')).toEqual([prose]); // English stemming
        expect(await search('CELLO')).toEqual([prose, json]); // case-insensitive
        expect(await search(`"sad cello"`)).toEqual([prose]); // phrases
        expect(await search(`${w} -melody`)).toEqual([tagged, json]); // exclusion
        expect(await search(`${w}-tag or ${other}`)).toEqual([tagged, unrelated]);
        expect(await search(other)).toEqual([unrelated]); // JSON keys aren't searched
        expect(await search('60')).toEqual([]); // nor JSON numbers
    });

    it('only finds what the viewer can see', async () => {
        const [owner, other] = [await newUser(), await newUser()];
        const sound = await createSound(owner);
        const w = word();
        const res = await owner.client.post(sound.links.annotations, {
            annotations: [
                { schema: 'text@1', text: `public ${w}`, access: '*' },
                { schema: 'text@1', text: `private ${w}`, access: null },
            ],
        });
        const [shown] = ids(res.body.items);
        expect(ids((await other.client.get(`/annotations?q=${w}`)).body.items)).toEqual([shown]);
        expect((await owner.client.get(`/annotations?q=${w}`)).body.items).toHaveLength(2);
    });
});

describe('property filters (prop=key:value)', () => {
    it('match JSON values exactly, by type, nested, and in arrays', async () => {
        const user = await newUser();
        const sound = await createSound(user);
        const w = word();
        const res = await user.client.post(sound.links.annotations, {
            annotations: [
                { schema: 'kv@1', kv: { run: w, instrument_name: 'Piano', note: 60, meta: { source: 'a:b' } }, access: '*' },
                { schema: 'kv@1', kv: { run: w, instrument_name: 'Cello', note: '60', moods: ['warm', 'dark'] }, access: '*' },
                { schema: 'kv@1', kv: { run: w, instrument_name: 'Piano', note: 61, ok: true }, access: '*' },
            ],
        });
        const [piano60, cello, piano61] = ids(res.body.items);
        const filter = (...props: string[]) =>
            user.client
                .walk(`/annotations?${props.map((p) => `prop=${encodeURIComponent(p)}`).join('&')}&prop=run:${w}`)
                .then(ids);

        expect(await filter('instrument_name:Piano')).toEqual([piano60, piano61]);
        expect(await filter('instrument_name:piano')).toEqual([]); // exact: case-sensitive
        expect(await filter('note:60')).toEqual([piano60, cello]); // the number 60, or the string "60"
        expect(await filter('meta.source:a:b')).toEqual([piano60]); // nested; colons after the first are the value's
        expect(await filter('moods:dark')).toEqual([cello]); // an element of an array
        expect(await filter('ok:true')).toEqual([piano61]);
        expect(await filter('instrument_name:Piano', 'note:61')).toEqual([piano61]); // all must hold
    });

    it('combine with q and the other filters, and survive paging', async () => {
        const user = await newUser();
        const sound = await createSound(user);
        const w = word();
        await user.client.post(sound.links.annotations, {
            annotations: [1, 2, 3].map((n) => ({ schema: 'kv@1', kv: { run: w, n, label: `${w} item` }, access: '*' })),
        });
        // page_size=1: the next links must carry both props, and q
        const items = await user.client.walk(`/annotations?q=${w}&prop=run:${w}&prop=label:${w}%20item&page_size=1&schema=kv@1`);
        expect(items.map((a: { kv: { n: number } }) => a.kv.n)).toEqual([1, 2, 3]);
    });

    it('reject malformed filters', async () => {
        const user = await newUser();
        expect((await user.client.get('/annotations?prop=no-colon')).status).toBe(400);
        expect((await user.client.get('/annotations?prop=a..b:x')).status).toBe(400);
        const many = Array.from({ length: 11 }, (_, i) => `prop=k${i}:v`).join('&');
        expect((await user.client.get(`/annotations?${many}`)).status).toBe(400);
    });
});
