import type { AnnotationKind, AnnotationSchemaResource } from '@cochlea/shared';
import express, { Router } from 'express';
import { annotationPolicy } from '../../annotations/domain';
import { principalOf } from '../../auth/adapters/express';
import type { Principal } from '../../auth/domain';
import { feedQuerySchemaProperties, parseFeedRequest, renderFeedPage } from '../../shared/http/paging';
import { linkMap, type Links } from '../../shared/http/links';
import { requireValidBody, requireValidQuery } from '../../shared/http/validation';
import type { AnnotationSchemaId } from '../../shared/ids';
import { type AnnotationSchema, annotationSchemaPolicy, type AnnotationSchemasDomain, schemaRef } from '../domain';
import createSchema from './createAnnotationSchemaRequestBody.schema.json';

export const renderAnnotationSchema = (links: Links, actor: Principal, s: AnnotationSchema): AnnotationSchemaResource => ({
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
    links: linkMap({
        self: links.get(`/annotation-schemas/${schemaRef(s)}`),
        annotations: annotationPolicy.read(actor) && links.get('/annotations', { schema: schemaRef(s) }),
        created_by: links.get(`/users/${s.createdBy}`),
    }),
});

const feedQuerySchema = { type: 'object', additionalProperties: false, properties: feedQuerySchemaProperties };

export const router = (domain: AnnotationSchemasDomain, links: Links): Router => {
    const r = Router();

    r.get('/annotation-schemas', requireValidQuery(feedQuerySchema), async (req, res) => {
        const actor = principalOf(res);
        const page = await domain.listSchemas(actor, parseFeedRequest<AnnotationSchemaId>(req));
        res.json(
            renderFeedPage(req, links, '/annotation-schemas', page, (s) => renderAnnotationSchema(links, actor, s), {
                create: annotationSchemaPolicy.create(actor) && links.post('/annotation-schemas', createSchema),
            })
        );
    });

    r.post('/annotation-schemas', express.json(), requireValidBody(createSchema), async (req, res) => {
        const body = req.body as {
            name: string;
            kind: AnnotationKind;
            vector_dim?: number | null;
            json_schema?: object | null;
            description?: string;
        };
        const actor = principalOf(res);
        const schema = await domain.createSchema(actor, {
            name: body.name,
            kind: body.kind,
            vectorDim: body.vector_dim ?? null,
            jsonSchema: body.json_schema ?? null,
            description: body.description ?? '',
        });
        const rendered = renderAnnotationSchema(links, actor, schema);
        res.status(201).location(rendered.links.self!.href).json(rendered);
    });

    r.get('/annotation-schemas/:ref', async (req, res) => {
        const actor = principalOf(res);
        const schema = await domain.getSchema(actor, req.params.ref);
        res.json(renderAnnotationSchema(links, actor, schema));
    });

    return r;
};
