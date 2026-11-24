import type { LicenseType, SoundFormatResource, SoundResource } from '@cochlea/shared';
import express, { type Request, type Response, Router } from 'express';
import { principalOf } from '../../auth/adapters/express';
import type { Links } from '../../shared/http/links';
import { parseFeedRequest, renderFeedPage } from '../../shared/http/paging';
import { requireValidBody, requireValidQuery } from '../../shared/http/validation';
import { type SoundId, toSoundFormatId, toSoundId, toUserId, type UserId } from '../../shared/ids';
import type { NewSoundFormat, Sound, SoundFormat, SoundsDomain } from '../domain';
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

export const renderFormat = (links: Links, f: SoundFormat): SoundFormatResource => ({
    id: f.id,
    sound_id: f.soundId,
    url: f.url,
    mime_type: f.mimeType,
    metadata: f.metadata,
    created_by: f.createdBy,
    created_at: f.createdAt.toISOString(),
    links: {
        self: links.href(`/sounds/${f.soundId}/formats/${f.id}`),
        sound: links.href(`/sounds/${f.soundId}`),
        created_by: links.href(`/users/${f.createdBy}`),
        file: f.url,
    },
});

export const renderSound = (links: Links, s: Sound): SoundResource => ({
    id: s.id,
    created_at: s.createdAt.toISOString(),
    created_by: s.createdBy,
    audio_url: s.audioUrl,
    info_url: s.infoUrl,
    license_type: s.licenseType,
    title: s.title,
    duration_seconds: s.durationSeconds,
    formats: s.formats.map((f) => renderFormat(links, f)),
    links: {
        self: links.href(`/sounds/${s.id}`),
        annotations: links.href(`/sounds/${s.id}/annotations`),
        formats: links.href(`/sounds/${s.id}/formats`),
        created_by: links.href(`/users/${s.createdBy}`),
        audio: s.audioUrl,
    },
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
        const page = await domain.listSounds(principalOf(res), {
            ...parseFeedRequest<SoundId>(req),
            createdBy: createdBy ?? (q.created_by ? toUserId(q.created_by) : null),
        });
        res.json(renderFeedPage(req, links, path, page, (s) => renderSound(links, s)));
    };

    r.get('/sounds', requireValidQuery(soundFeedQuerySchema), (req, res) => feed(req, res, '/sounds', null));

    r.get('/users/:userId/sounds', requireValidQuery(soundFeedQuerySchema), (req, res) => {
        const userId = toUserId(req.params.userId);
        return feed(req, res, `/users/${userId}/sounds`, userId);
    });

    r.post('/sounds', express.json(), requireValidBody(createSoundSchema), async (req, res) => {
        const body = req.body as CreateSoundBody;
        const sound = await domain.createSound(principalOf(res), {
            audioUrl: body.audio_url,
            infoUrl: body.info_url ?? null,
            formats: (body.formats ?? []).map(toNewFormat),
            licenseType: body.license_type,
            title: body.title ?? null,
            durationSeconds: body.duration_seconds,
        });
        const rendered = renderSound(links, sound);
        res.status(201).location(rendered.links.self!).json(rendered);
    });

    r.get('/sounds/:soundId', async (req, res) => {
        const sound = await domain.getSound(principalOf(res), toSoundId(req.params.soundId));
        res.json(renderSound(links, sound));
    });

    r.delete('/sounds/:soundId', async (req, res) => {
        await domain.deleteSound(principalOf(res), toSoundId(req.params.soundId));
        res.status(204).end();
    });

    r.get('/sounds/:soundId/formats', async (req, res) => {
        const sound = await domain.getSound(principalOf(res), toSoundId(req.params.soundId));
        res.json({ items: sound.formats.map((f) => renderFormat(links, f)) });
    });

    r.post('/sounds/:soundId/formats', express.json(), requireValidBody(createSoundFormatSchema), async (req, res) => {
        const format = await domain.addFormat(
            principalOf(res),
            toSoundId(req.params.soundId),
            toNewFormat(req.body as CreateFormatBody)
        );
        const rendered = renderFormat(links, format);
        res.status(201).location(rendered.links.self!).json(rendered);
    });

    r.get('/sounds/:soundId/formats/:formatId', async (req, res) => {
        const format = await domain.getFormat(
            principalOf(res),
            toSoundId(req.params.soundId),
            toSoundFormatId(req.params.formatId)
        );
        res.json(renderFormat(links, format));
    });

    r.delete('/sounds/:soundId/formats/:formatId', async (req, res) => {
        await domain.deleteFormat(principalOf(res), toSoundId(req.params.soundId), toSoundFormatId(req.params.formatId));
        res.status(204).end();
    });

    return r;
};
