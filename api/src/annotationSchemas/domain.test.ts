/** @group unit */
import { InvalidRequest, PermissionDenied } from '../shared/errors';
import type { AnnotationSchemaId, UserId } from '../shared/ids';
import { firebasePrincipal } from '../testing';
import {
    type AnnotationSchema,
    type AnnotationSchemasPersistence,
    buildAnnotationSchemasDomain,
    type NewAnnotationSchema,
    parseSchemaRef,
} from './domain';

const inMemory = (indexed = new Set<AnnotationSchemaId>()): AnnotationSchemasPersistence => {
    const schemas: AnnotationSchema[] = [];
    return {
        vectorSchemas: async () => schemas.filter((s) => s.kind === 'vector'),
        async ensureVectorIndex(schema) {
            if (indexed.has(schema.id)) return 'exists';
            indexed.add(schema.id);
            return 'created';
        },
        scheduleVectorIndex(schema) {
            indexed.add(schema.id);
        },
        async insertNextVersion(createdBy, schema) {
            const versions = schemas.filter((s) => s.name === schema.name);
            const latest = versions[versions.length - 1];
            if (latest && latest.createdBy !== createdBy) return { status: 'notOwner' };
            const created: AnnotationSchema = {
                ...schema,
                id: (schemas.length + 1) as AnnotationSchemaId,
                version: (latest?.version ?? 0) + 1,
                annotationCount: 0,
                createdAt: new Date(),
                createdBy,
            };
            schemas.push(created);
            return { status: 'created', schema: created };
        },
        getByRef: async (name, version) => schemas.find((s) => s.name === name && s.version === version) ?? null,
        getByRefs: async (refs) =>
            schemas.filter((s) => refs.some((r) => r.name === s.name && r.version === s.version)),
        getById: async (id) => schemas.find((s) => s.id === id) ?? null,
        feed: async () => ({ items: schemas, hasMore: false }),
    };
};

const tags: NewAnnotationSchema = { name: 'tags', kind: 'tags', vectorDim: null, jsonSchema: null, description: '' };

describe('annotation schemas', () => {
    it('parses refs', () => {
        expect(parseSchemaRef('chroma-mean@12')).toEqual({ name: 'chroma-mean', version: 12 });
        expect(() => parseSchemaRef('Chroma@1')).toThrow(InvalidRequest);
        expect(() => parseSchemaRef('chroma@0')).toThrow(InvalidRequest);
        expect(() => parseSchemaRef('chroma')).toThrow(InvalidRequest);
    });

    it('requires ANNOTATION_SCHEMA_CREATOR', async () => {
        const domain = buildAnnotationSchemasDomain(inMemory(), () => []);
        await expect(domain.createSchema(firebasePrincipal(1, ['ANNOTATION_SCHEMA_READER']), tags)).rejects.toThrow(
            PermissionDenied
        );
    });

    it('versions schemas, and only lets the owner publish new versions', async () => {
        const domain = buildAnnotationSchemasDomain(inMemory(), () => []);
        expect((await domain.createSchema(firebasePrincipal(1), tags)).version).toBe(1);
        expect((await domain.createSchema(firebasePrincipal(1), tags)).version).toBe(2);
        await expect(domain.createSchema(firebasePrincipal(2), tags)).rejects.toThrow(PermissionDenied);
    });

    it('requires vector_dim for, and only for, vector schemas', async () => {
        const domain = buildAnnotationSchemasDomain(inMemory(), () => []);
        const actor = firebasePrincipal(1);
        await expect(domain.createSchema(actor, { ...tags, kind: 'vector' })).rejects.toThrow(/vector_dim/);
        await expect(domain.createSchema(actor, { ...tags, vectorDim: 3 })).rejects.toThrow(/vector_dim/);
        const v = await domain.createSchema(actor, { ...tags, name: 'v', kind: 'vector', vectorDim: 3 });
        expect(v.vectorDim).toBe(3);
        // pgvector can't index more than 2000 dimensions
        await expect(domain.createSchema(actor, { ...tags, name: 'big', kind: 'vector', vectorDim: 2001 })).rejects.toThrow(/between 1 and 2000/);
        expect((await domain.createSchema(actor, { ...tags, name: 'max', kind: 'vector', vectorDim: 2000 })).vectorDim).toBe(2000);
    });

    it('rejects invalid json schemas', async () => {
        const domain = buildAnnotationSchemasDomain(inMemory(), () => ['bad schema']);
        await expect(
            domain.createSchema(firebasePrincipal(1), { ...tags, jsonSchema: { type: 'wat' } })
        ).rejects.toThrow(/bad schema/);
    });

    it('rejects unknown refs when resolving', async () => {
        const domain = buildAnnotationSchemasDomain(inMemory(), () => []);
        await domain.createSchema(firebasePrincipal(1 as UserId), tags);
        const resolved = await domain.resolveRefs(['tags@1', 'tags@1']);
        expect(resolved.size).toBe(1);
        await expect(domain.resolveRefs(['tags@1', 'text@1'])).rejects.toThrow(/text@1/);
    });

    it('gives every vector schema its own search index', async () => {
        const indexed = new Set<AnnotationSchemaId>();
        const domain = buildAnnotationSchemasDomain(inMemory(indexed), () => []);
        const vector = await domain.createSchema(firebasePrincipal(1), { ...tags, name: 'v', kind: 'vector', vectorDim: 25 });
        await domain.createSchema(firebasePrincipal(1), tags);
        expect([...indexed]).toEqual([vector.id]);
        expect(await domain.ensureVectorIndexes()).toEqual([]);
        indexed.clear();
        expect(await domain.ensureVectorIndexes()).toEqual(['v@1']);
    });
});
