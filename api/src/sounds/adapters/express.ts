import type { LicenseType, SoundFormatResource, SoundResource } from '@cochlea/shared';
import express, { type Request, type Response, Router } from 'express';
import { createAnnotationsSchema } from '../../annotations';
import { annotationPolicy } from '../../annotations/domain';
import { principalOf } from '../../auth/adapters/express';
import type { Principal } from '../../auth/domain';
import { linkMap, type Links } from '../../shared/http/links';
import { parseFeedRequest, renderFeedPage } from '../../shared/http/paging';
import { requireValidBody, requireValidQuery } from '../../shared/http/validation';
import { type SoundId, toSoundFormatId, toSoundId, toUserId, type UserId } from '../../shared/ids';
import { type NewSoundFormat, type Sound, type SoundFormat, type SoundsDomain, soundPolicy } from '../domain';
import createSoundFile from './createSoundRequestBody.schema.json';
import createSoundFormatFile from './createSoundFormatRequestBody.schema.json';
import soundFeedQuerySchema from './soundFeedQuery.schema.json';

// The create-sound body embeds the format schema for its `formats` (the
// validator compiles each schema on its own, so a $ref between files wouldn't
// resolve). The OpenAPI spec uses both.
const { $id: _formatId, ...formatItem } = createSoundFormatFile;
export const createSoundFormatSchema = createSoundFormatFile;
export const createSoundSchema = {
    ...createSoundFile,
    properties: {
        ...createSoundFile.properties,
        formats: { ...createSoundFile.properties.formats, items: formatItem },
    },
};

export const renderFormat = (links: Links, actor: Principal, f: SoundFormat): SoundFormatResource => ({
    id: f.id,
    sound_id: f.soundId,
    url: f.url,
    mime_type: f.mimeType,
    metadata: f.metadata,
    created_by: f.createdBy,
    created_at: f.createdAt.toISOString(),
    links: linkMap({
        self: links.get(`/sounds/${f.soundId}/formats/${f.id}`),
        sound: links.get(`/sounds/${f.soundId}`),
        created_by: links.get(`/users/${f.createdBy}`),
        file: links.external(f.url),
        delete: soundPolicy.deleteFormat(actor, f) && links.delete(`/sounds/${f.soundId}/formats/${f.id}`),
    }),
});

export const renderSound = (links: Links, actor: Principal, s: Sound): SoundResource => ({
    id: s.id,
    created_at: s.createdAt.toISOString(),
    created_by: s.createdBy,
    audio_url: s.audioUrl,
    info_url: s.infoUrl,
    license_type: s.licenseType,
    title: s.title,
    duration_seconds: s.durationSeconds,
    formats: s.formats.map((f) => renderFormat(links, actor, f)),
    links: linkMap({
        self: links.get(`/sounds/${s.id}`),
        audio: links.external(s.audioUrl),
        created_by: links.get(`/users/${s.createdBy}`),
        annotations: annotationPolicy.read(actor) && links.get(`/sounds/${s.id}/annotations`),
        create_annotations:
            annotationPolicy.create(actor) && links.post(`/sounds/${s.id}/annotations`, createAnnotationsSchema),
        formats: links.get(`/sounds/${s.id}/formats`),
        add_format: soundPolicy.addFormat(actor) && links.post(`/sounds/${s.id}/formats`, createSoundFormatSchema),
        delete: soundPolicy.delete(actor, s) && links.delete(`/sounds/${s.id}`),
    }),
});

interface CreateFormatBody {
    url: string;
    mime_type: string;
    metadata?: Record<string, unknown>;
}

interface CreateSoundBody {
    audio_url: string;
    info_url?: string | null;
    license_type: LicenseType;
    title?: string | null;
    duration_seconds: number;
    formats?: CreateFormatBody[];
}

const toNewFormat = (f: CreateFormatBody): NewSoundFormat => ({
    url: f.url,
    mimeType: f.mime_type,
    metadata: f.metadata ?? {},
});

export const router = (domain: SoundsDomain, links: Links): Router => {
    const r = Router();

    const feed = async (req: Request, res: Response, path: string, createdBy: UserId | null) => {
        const q = req.query as Record<string, string | undefined>;
        const actor = principalOf(res);
        const page = await domain.listSounds(actor, {
            ...parseFeedRequest<SoundId>(req),
            createdBy: createdBy ?? (q.created_by ? toUserId(q.created_by) : null),
        });
        res.json(
            renderFeedPage(req, links, path, page, (s) => renderSound(links, actor, s), {
                create: soundPolicy.create(actor) && links.post('/sounds', createSoundSchema),
            })
        );
    };

    r.get('/sounds', requireValidQuery(soundFeedQuerySchema), (req, res) => feed(req, res, '/sounds', null));

    r.get('/users/:userId/sounds', requireValidQuery(soundFeedQuerySchema), (req, res) => {
        const userId = toUserId(req.params.userId);
        return feed(req, res, `/users/${userId}/sounds`, userId);
    });

    r.post('/sounds', express.json(), requireValidBody(createSoundSchema), async (req, res) => {
        const body = req.body as CreateSoundBody;
        const actor = principalOf(res);
        const sound = await domain.createSound(actor, {
            audioUrl: body.audio_url,
            infoUrl: body.info_url ?? null,
            formats: (body.formats ?? []).map(toNewFormat),
            licenseType: body.license_type,
            title: body.title ?? null,
            durationSeconds: body.duration_seconds,
        });
        const rendered = renderSound(links, actor, sound);
        res.status(201).location(rendered.links.self!.href).json(rendered);
    });

    r.get('/sounds/:soundId', async (req, res) => {
        const actor = principalOf(res);
        const sound = await domain.getSound(actor, toSoundId(req.params.soundId));
        res.json(renderSound(links, actor, sound));
    });

    r.delete('/sounds/:soundId', async (req, res) => {
        await domain.deleteSound(principalOf(res), toSoundId(req.params.soundId));
        res.status(204).end();
    });

    r.get('/sounds/:soundId/formats', async (req, res) => {
        const actor = principalOf(res);
        const sound = await domain.getSound(actor, toSoundId(req.params.soundId));
        res.json({
            items: sound.formats.map((f) => renderFormat(links, actor, f)),
            links: linkMap({
                self: links.get(`/sounds/${sound.id}/formats`),
                sound: links.get(`/sounds/${sound.id}`),
                create: soundPolicy.addFormat(actor) && links.post(`/sounds/${sound.id}/formats`, createSoundFormatSchema),
            }),
        });
    });

    r.post('/sounds/:soundId/formats', express.json(), requireValidBody(createSoundFormatSchema), async (req, res) => {
        const actor = principalOf(res);
        const format = await domain.addFormat(
            actor,
            toSoundId(req.params.soundId),
            toNewFormat(req.body as CreateFormatBody)
        );
        const rendered = renderFormat(links, actor, format);
        res.status(201).location(rendered.links.self!.href).json(rendered);
    });

    r.get('/sounds/:soundId/formats/:formatId', async (req, res) => {
        const actor = principalOf(res);
        const format = await domain.getFormat(
            actor,
            toSoundId(req.params.soundId),
            toSoundFormatId(req.params.formatId)
        );
        res.json(renderFormat(links, actor, format));
    });

    r.delete('/sounds/:soundId/formats/:formatId', async (req, res) => {
        await domain.deleteFormat(principalOf(res), toSoundId(req.params.soundId), toSoundFormatId(req.params.formatId));
        res.status(204).end();
    });

    return r;
};
