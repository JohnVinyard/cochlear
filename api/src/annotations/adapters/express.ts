import type { AnnotationKind, AnnotationResource, NewAnnotation, Access as WireAccess } from '@cochlea/shared';
import express, { type Request, type Response, Router } from 'express';
import { principalOf } from '../../auth/adapters/express';
import { HttpError } from '../../shared/http/errors';
import type { Links } from '../../shared/http/links';
import { parseFeedRequest, renderFeedPage } from '../../shared/http/paging';
import { requireValidBody, requireValidQuery } from '../../shared/http/validation';
import { type AnnotationId, type SoundId, toAnnotationId, toSoundId, toUserId, type UserId } from '../../shared/ids';
import type { Access, Annotation, AnnotationInput, AnnotationsDomain } from '../domain';
import createAnnotationsSchema from './createAnnotationsRequestBody.schema.json';
import feedQuerySchema from './annotationFeedQuery.schema.json';

const toWireAccess = (access: Access): WireAccess =>
    access.type === 'public' ? '*' : access.type === 'private' ? null : access.userIds;

const fromWireAccess = (access: WireAccess): Access =>
    access === null
        ? { type: 'private' }
        : access === '*'
          ? { type: 'public' }
          : { type: 'users', userIds: access.map((id) => toUserId(id)) };

export const renderAnnotation = (links: Links, a: Annotation, viewer: UserId): AnnotationResource => {
    const value = (() => {
        switch (a.value.kind) {
            case 'tags':
                return { tags: a.value.tags };
            case 'text':
                return { text: a.value.text };
            case 'vector':
                return { vector: a.value.vector };
            case 'kv':
                return { kv: a.value.kv };
            case 'blob':
                return { blob: { url: a.value.blob.url, content_type: a.value.blob.contentType } };
        }
    })();
    return {
        id: a.id,
        created_at: a.createdAt.toISOString(),
        created_by: a.createdBy,
        sound_id: a.soundId,
        schema: a.schemaRef,
        kind: a.value.kind,
        start_seconds: a.segment?.startSeconds ?? null,
        duration_seconds: a.segment?.durationSeconds ?? null,
        end_seconds: a.segment ? a.segment.startSeconds + a.segment.durationSeconds : null,
        ...value,
        data: a.data,
        // who else can see an annotation is the creator's business
        ...(a.createdBy === viewer ? { access: toWireAccess(a.access) } : {}),
        links: {
            self: links.href(`/annotations/${a.id}`),
            sound: links.href(`/sounds/${a.soundId}`),
            schema: links.href(`/annotation-schemas/${a.schemaRef}`),
            created_by: links.href(`/users/${a.createdBy}`),
        },
    };
};

const fromWire = (a: NewAnnotation): AnnotationInput => ({
    schema: a.schema,
    startSeconds: a.start_seconds,
    durationSeconds: a.duration_seconds,
    tags: a.tags,
    text: a.text,
    vector: a.vector,
    kv: a.kv,
    blob: a.blob ? { url: a.blob.url, contentType: a.blob.content_type } : undefined,
    data: a.data,
    access: fromWireAccess(a.access),
});

const parseTimeRange = (raw: string | undefined) => {
    if (!raw) return null;
    const [start, end] = raw.split('-').map(Number);
    return { start: start!, end: end! };
};

export const router = (domain: AnnotationsDomain, links: Links): Router => {
    const r = Router();
    const validQuery = requireValidQuery(feedQuerySchema);

    const feed = async (
        req: Request,
        res: Response,
        path: string,
        scope: { soundId?: SoundId; createdBy?: UserId }
    ) => {
        const principal = principalOf(res);
        const q = req.query as Record<string, string | undefined>;
        if (q.time_range && !scope.soundId) {
            throw new HttpError(400, ['time_range is only supported for a single sound\'s annotations']);
        }
        const page = await domain.listAnnotations(principal, {
            ...parseFeedRequest<AnnotationId>(req),
            soundId: scope.soundId ?? null,
            createdBy: scope.createdBy ?? (q.created_by ? toUserId(q.created_by) : null),
            schema: q.schema ?? null,
            kind: (q.kind as AnnotationKind | undefined) ?? null,
            tags: q.tags ? q.tags.split(',').map((t) => t.trim()).filter(Boolean) : null,
            timeRange: parseTimeRange(q.time_range),
        });
        res.json(renderFeedPage(req, links, path, page, (a) => renderAnnotation(links, a, principal.user.id)));
    };

    r.get('/annotations', validQuery, (req, res) => feed(req, res, '/annotations', {}));

    r.get('/users/:userId/annotations', validQuery, (req, res) => {
        const createdBy = toUserId(req.params.userId);
        return feed(req, res, `/users/${createdBy}/annotations`, { createdBy });
    });

    r.get('/sounds/:soundId/annotations', validQuery, (req, res) => {
        const soundId = toSoundId(req.params.soundId);
        return feed(req, res, `/sounds/${soundId}/annotations`, { soundId });
    });

    r.post(
        '/sounds/:soundId/annotations',
        express.json({ limit: '10mb' }),
        requireValidBody(createAnnotationsSchema),
        async (req, res) => {
            const principal = principalOf(res);
            const soundId = toSoundId(req.params.soundId);
            const body = req.body as { annotations: NewAnnotation[] };
            const created = await domain.createAnnotations(principal, soundId, body.annotations.map(fromWire));
            const location = links.href(`/sounds/${soundId}/annotations`);
            res.status(201)
                .location(location)
                .json({
                    items: created.map((a) => renderAnnotation(links, a, principal.user.id)),
                    links: { sound_annotations: location },
                });
        }
    );

    r.get('/annotations/:annotationId', async (req, res) => {
        const principal = principalOf(res);
        const annotation = await domain.getAnnotation(principal, toAnnotationId(req.params.annotationId));
        res.json(renderAnnotation(links, annotation, principal.user.id));
    });

    r.delete('/annotations/:annotationId', async (req, res) => {
        await domain.deleteAnnotation(principalOf(res), toAnnotationId(req.params.annotationId));
        res.status(204).end();
    });

    return r;
};
