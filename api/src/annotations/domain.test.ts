/** @group unit */
import type { AnnotationSchema } from '../annotationSchemas/domain';
import { Gone, InvalidRequest, NotFound, PermissionDenied } from '../shared/errors';
import type { AnnotationId, AnnotationSchemaId, SoundId, UserId } from '../shared/ids';
import type { Sound, SoundLookup } from '../sounds/domain';
import { firebasePrincipal } from '../testing';
import {
    type Annotation,
    type AnnotationInput,
    type AnnotationsPersistence,
    buildAnnotationsDomain,
    parsePropertyFilter,
    normalizeAccess,
    validateSegment,
    validateValue,
} from './domain';

const schema = (name: string, kind: AnnotationSchema['kind'], extra: Partial<AnnotationSchema> = {}): AnnotationSchema => ({
    id: name.length as AnnotationSchemaId,
    name,
    version: 1,
    kind,
    vectorDim: kind === 'vector' ? 3 : null,
    jsonSchema: null,
    description: '',
    createdAt: new Date(),
    createdBy: 1 as UserId,
    annotationCount: 0,
    ...extra,
});

const SCHEMAS = new Map([
    ['tags@1', schema('tags', 'tags')],
    ['vec@1', schema('vec', 'vector')],
    ['strict@1', schema('strict', 'kv', { jsonSchema: { type: 'object', required: ['n'] } })],
]);

const sound = { id: 1 as SoundId, durationSeconds: 10 } as Sound;

const setup = (soundLookup: SoundLookup = { status: 'found', sound }) => {
    const stored: Annotation[] = [];
    const deleted = new Set<number>();
    const nearestQueries: Parameters<AnnotationsPersistence['nearest']>[1][] = [];
    const persistence: AnnotationsPersistence = {
        async insertBatch(createdBy, soundId, annotations) {
            const created = annotations.map((a, i) => ({
                ...a,
                id: (stored.length + i + 1) as AnnotationId,
                soundId,
                createdBy,
                createdAt: new Date(),
            }));
            stored.push(...created);
            return created;
        },
        async lookup(id, viewer) {
            const a = stored.find((x) => x.id === id);
            if (!a) return { status: 'missing' };
            const visible =
                a.createdBy === viewer ||
                a.access.type === 'public' ||
                (a.access.type === 'users' && a.access.userIds.includes(viewer));
            return { status: deleted.has(id) ? 'deleted' : 'found', annotation: a, visible };
        },
        feed: async () => ({ items: stored, hasMore: false }),
        markDeleted: async (id) => void deleted.add(id),
        async nearest(_viewer, query) {
            nearestQueries.push(query);
            return [];
        },
    };
    const domain = buildAnnotationsDomain(persistence, {
        schemas: {
            async resolveRefs(refs) {
                const unknown = refs.filter((r) => !SCHEMAS.has(r));
                if (unknown.length) throw new InvalidRequest([`unknown ${unknown}`]);
                return SCHEMAS;
            },
            getById: async (id) => [...SCHEMAS.values()].find((s) => s.id === id) ?? null,
        },
        sounds: { lookupSound: async () => soundLookup },
        users: {
            async requireUsersExist(ids) {
                if (ids.some((id) => id > 100)) throw new InvalidRequest(['unknown user']);
            },
        },
        validateJson: (s, data) =>
            (s as { required: string[] }).required.every((k) => typeof data === 'object' && data && k in data)
                ? []
                : ['data is missing required fields'],
    });
    return { domain, stored, nearestQueries };
};

const tagsInput = (extra: Partial<AnnotationInput> = {}): AnnotationInput => ({
    schema: 'tags@1',
    tags: ['piano'],
    access: { type: 'public' },
    ...extra,
});

describe('segments', () => {
    it('allows whole-sound annotations', () => {
        expect(validateSegment({}, 10)).toEqual({ segment: null, errors: [] });
    });
    it('requires start and duration together', () => {
        expect(validateSegment({ startSeconds: 1 }, 10).errors).toHaveLength(1);
    });
    it('must fit within the sound', () => {
        expect(validateSegment({ startSeconds: 9, durationSeconds: 1 }, 10).errors).toEqual([]);
        expect(validateSegment({ startSeconds: 9, durationSeconds: 2 }, 10).errors[0]).toMatch(/after the end/);
    });
});

describe('values', () => {
    it('must match the schema kind', () => {
        const result = validateValue({ schema: 'tags@1', text: 'x', access: { type: 'private' } }, SCHEMAS.get('tags@1')!);
        expect(result.value).toBeNull();
        expect(result.errors.join()).toMatch(/unexpected field\(s\): text/);
    });
    it('dedupes and trims tags', () => {
        const result = validateValue(tagsInput({ tags: [' a', 'a', 'b'] }), SCHEMAS.get('tags@1')!);
        expect(result.value).toEqual({ kind: 'tags', tags: ['a', 'b'] });
    });
    it("checks a vector's dimension", () => {
        const s = SCHEMAS.get('vec@1')!;
        expect(validateValue({ schema: 'vec@1', vector: [1, 2], access: null as never }, s).errors[0]).toMatch(
            /exactly 3/
        );
        expect(validateValue({ schema: 'vec@1', vector: [1, 2, 3], access: null as never }, s).errors).toEqual([]);
    });
});

describe('access', () => {
    it('never lists the creator', () => {
        expect(normalizeAccess({ type: 'users', userIds: [1, 2, 2] as UserId[] }, 1 as UserId)).toEqual({
            type: 'users',
            userIds: [2],
        });
    });
});

describe('annotations', () => {
    const actor = firebasePrincipal(1);

    it('requires ANNOTATION_EDITOR to create', async () => {
        const { domain } = setup();
        await expect(
            domain.createAnnotations(firebasePrincipal(1, ['ANNOTATION_READER']), 1 as SoundId, [tagsInput()])
        ).rejects.toThrow(PermissionDenied);
    });

    it('is all-or-nothing, reporting every invalid item', async () => {
        const { domain, stored } = setup();
        const err = await domain
            .createAnnotations(actor, 1 as SoundId, [
                tagsInput(),
                tagsInput({ startSeconds: 20, durationSeconds: 1 }),
                { schema: 'strict@1', kv: {}, data: {}, access: { type: 'private' } },
            ])
            .catch((e) => e);
        expect(err).toBeInstanceOf(InvalidRequest);
        expect(err.reasons).toEqual([
            expect.stringMatching(/^annotations\[1\]: segment ends/),
            expect.stringMatching(/^annotations\[2\]: data is missing/),
        ]);
        expect(stored).toHaveLength(0);
    });

    it('rejects annotations for missing or deleted sounds', async () => {
        await expect(setup({ status: 'missing' }).domain.createAnnotations(actor, 1 as SoundId, [tagsInput()])).rejects.toThrow(NotFound);
        await expect(
            setup({ status: 'deleted', sound }).domain.createAnnotations(actor, 1 as SoundId, [tagsInput()])
        ).rejects.toThrow(Gone);
    });

    it('rejects unknown grantees', async () => {
        const { domain } = setup();
        await expect(
            domain.createAnnotations(actor, 1 as SoundId, [tagsInput({ access: { type: 'users', userIds: [101 as UserId] } })])
        ).rejects.toThrow(/unknown user/);
    });

    it('hides private annotations, and lets only the creator delete', async () => {
        const { domain } = setup();
        const [privateOne, sharedOne] = await domain.createAnnotations(actor, 1 as SoundId, [
            tagsInput({ access: { type: 'private' } }),
            tagsInput({ access: { type: 'users', userIds: [2 as UserId] } }),
        ]);
        const other = firebasePrincipal(2);
        await expect(domain.getAnnotation(other, privateOne!.id)).rejects.toThrow(NotFound);
        await expect(domain.getAnnotation(other, sharedOne!.id)).resolves.toBeDefined();
        await expect(domain.deleteAnnotation(other, sharedOne!.id)).rejects.toThrow(PermissionDenied);
        await domain.deleteAnnotation(actor, sharedOne!.id);
        await expect(domain.getAnnotation(other, sharedOne!.id)).rejects.toThrow(Gone);
    });

    it('searches only vector annotations, within their own schema', async () => {
        const { domain, nearestQueries } = setup();
        const actor = firebasePrincipal(1);
        const [vector, tags] = await domain.createAnnotations(actor, sound.id, [
            { schema: 'vec@1', vector: [1, 2, 3], access: { type: 'public' } },
            { schema: 'tags@1', tags: ['x'], access: { type: 'public' } },
        ]);
        await domain.similarAnnotations(actor, vector!.id, { limit: 10, excludeSameSound: true });
        expect(nearestQueries).toEqual([
            { schemaId: vector!.schemaId, vectorDim: 3, vector: [1, 2, 3], limit: 10, excludeSoundId: sound.id },
        ]);
        await expect(domain.similarAnnotations(actor, tags!.id, { limit: 10, excludeSameSound: false })).rejects.toThrow(
            InvalidRequest
        );
        await expect(domain.similarAnnotations(actor, vector!.id, { limit: 0, excludeSameSound: false })).rejects.toThrow(
            InvalidRequest
        );
        await expect(domain.similarAnnotations(firebasePrincipal(9, []), vector!.id, { limit: 1, excludeSameSound: false }))
            .rejects.toThrow(PermissionDenied);
    });

    describe('property filters (prop=key:value)', () => {
        it('match a string, or a value of the type the text reads as, or an array element', () => {
            expect(parsePropertyFilter('instrument_name:Piano').candidates).toEqual([
                { instrument_name: 'Piano' },
                { instrument_name: ['Piano'] },
            ]);
            expect(parsePropertyFilter('note:60').candidates).toEqual([
                { note: '60' },
                { note: ['60'] },
                { note: 60 },
                { note: [60] },
            ]);
            expect(parsePropertyFilter('ok:true').candidates).toContainEqual({ ok: true });
            expect(parsePropertyFilter('gone:null').candidates).toContainEqual({ gone: null });
            expect(parsePropertyFilter('n:1.5e3').candidates).toContainEqual({ n: 1500 });
            expect(parsePropertyFilter('n:007').candidates).toHaveLength(2); // not a JSON number
        });

        it('reach into nested objects, and keep colons in values', () => {
            const f = parsePropertyFilter('meta.source:http://x');
            expect(f.path).toEqual(['meta', 'source']);
            expect(f.candidates[0]).toEqual({ meta: { source: 'http://x' } });
            expect(parsePropertyFilter('empty:').candidates[0]).toEqual({ empty: '' });
        });

        it('reject malformed filters', () => {
            for (const bad of ['no-colon', ':value', 'a..b:x', `k:${'x'.repeat(600)}`]) {
                expect(() => parsePropertyFilter(bad)).toThrow(InvalidRequest);
            }
        });
    });
});
