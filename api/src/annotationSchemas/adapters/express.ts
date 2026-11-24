import type { AnnotationKind, AnnotationSchemaResource } from '@cochlea/shared';
import express, { Router } from 'express';
import { principalOf } from '../../auth/adapters/express';
import { feedQuerySchemaProperties, parseFeedRequest, renderFeedPage } from '../../shared/http/paging';
import type { Links } from '../../shared/http/links';
import { requireValidBody, requireValidQuery } from '../../shared/http/validation';
import type { AnnotationSchemaId } from '../../shared/ids';
import { type AnnotationSchema, type AnnotationSchemasDomain, schemaRef } from '../domain';
import createSchema from './createAnnotationSchemaRequestBody.schema.json';

export const renderAnnotationSchema = (links: Links, s: AnnotationSchema): AnnotationSchemaResource => ({
    id: s.id,
    name: s.name,
    version: s.version,
    ref: schemaRef(s),
    kind: s.kind,
    vector_dim: s.vectorDim,
    json_schema: s.jsonSchema,
    description: s.description,
    created_at: s.createdAt.toISOString(),
    created_by: s.createdBy,
    annotation_count: s.annotationCount,
    links: {
        self: links.href(`/annotation-schemas/${schemaRef(s)}`),
        annotations: links.href('/annotations', { schema: schemaRef(s) }),
        created_by: links.href(`/users/${s.createdBy}`),
    },
});

const feedQuerySchema = { type: 'object', additionalProperties: false, properties: feedQuerySchemaProperties };

export const router = (domain: AnnotationSchemasDomain, links: Links): Router => {
    const r = Router();

    r.get('/annotation-schemas', requireValidQuery(feedQuerySchema), async (req, res) => {
        const page = await domain.listSchemas(principalOf(res), parseFeedRequest<AnnotationSchemaId>(req));
        res.json(renderFeedPage(req, links, '/annotation-schemas', page, (s) => renderAnnotationSchema(links, s)));
    });

    r.post('/annotation-schemas', express.json(), requireValidBody(createSchema), async (req, res) => {
        const body = req.body as {
            name: string;
            kind: AnnotationKind;
            vector_dim?: number | null;
            json_schema?: object | null;
            description?: string;
        };
        const schema = await domain.createSchema(principalOf(res), {
            name: body.name,
            kind: body.kind,
            vectorDim: body.vector_dim ?? null,
            jsonSchema: body.json_schema ?? null,
            description: body.description ?? '',
        });
        const rendered = renderAnnotationSchema(links, schema);
        res.status(201).location(rendered.links.self!).json(rendered);
    });

    r.get('/annotation-schemas/:ref', async (req, res) => {
        const schema = await domain.getSchema(principalOf(res), req.params.ref);
        res.json(renderAnnotationSchema(links, schema));
    });

    return r;
};
