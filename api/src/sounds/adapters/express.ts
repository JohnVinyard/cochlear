import type { LicenseType, SoundResource } from '@cochlea/shared';
import express, { type Request, type Response, Router } from 'express';
import { principalOf } from '../../auth/adapters/express';
import type { Links } from '../../shared/http/links';
import { parseFeedRequest, renderFeedPage } from '../../shared/http/paging';
import { requireValidBody, requireValidQuery } from '../../shared/http/validation';
import { type SoundId, toSoundId, toUserId, type UserId } from '../../shared/ids';
import type { Sound, SoundsDomain } from '../domain';
import createSoundSchema from './createSoundRequestBody.schema.json';
import soundFeedQuerySchema from './soundFeedQuery.schema.json';

export const renderSound = (links: Links, s: Sound): SoundResource => ({
    id: s.id,
    created_at: s.createdAt.toISOString(),
    created_by: s.createdBy,
    audio_url: s.audioUrl,
    info_url: s.infoUrl,
    low_quality_audio_url: s.lowQualityAudioUrl,
    license_type: s.licenseType,
    title: s.title,
    duration_seconds: s.durationSeconds,
    links: {
        self: links.href(`/sounds/${s.id}`),
        annotations: links.href(`/sounds/${s.id}/annotations`),
        created_by: links.href(`/users/${s.createdBy}`),
        audio: s.audioUrl,
    },
});

interface CreateSoundBody {
    audio_url: string;
    info_url?: string | null;
    low_quality_audio_url?: string | null;
    license_type: LicenseType;
    title?: string | null;
    duration_seconds: number;
}

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
            lowQualityAudioUrl: body.low_quality_audio_url ?? null,
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

    return r;
};
