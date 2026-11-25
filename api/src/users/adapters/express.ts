import type { UserResource } from '@cochlea/shared';
import express, { type Response, Router } from 'express';
import { annotationPolicy } from '../../annotations/domain';
import { createApiKeySchema } from '../../apiKeys';
import { apiKeyPolicy } from '../../apiKeys/domain';
import { principalOf } from '../../auth/adapters/express';
import type { Principal } from '../../auth/domain';
import { linkMap, type Links } from '../../shared/http/links';
import { HttpError } from '../../shared/http/errors';
import { requireValidBody } from '../../shared/http/validation';
import { toUserId } from '../../shared/ids';
import { soundPolicy } from '../../sounds/domain';
import type { User, UserState, UsersDomain } from '../domain';
import putMyStateSchema from './putMyStateRequestBody.schema.json';
import updateMeSchema from './updateMeRequestBody.schema.json';

export const renderUser = (links: Links, actor: Principal, user: User): UserResource => {
    const isMe = user.id === actor.user.id;
    const canManageKeys = isMe && apiKeyPolicy.manage(actor);
    return {
        id: user.id,
        user_name: user.userName,
        about_me: user.aboutMe,
        info_url: user.infoUrl,
        created_at: user.createdAt.toISOString(),
        ...(isMe ? { email: user.email, roles: user.roles } : {}),
        links: linkMap({
            self: links.get(`/users/${user.id}`),
            sounds: soundPolicy.read(actor) && links.get(`/users/${user.id}/sounds`),
            annotations: annotationPolicy.read(actor) && links.get(`/users/${user.id}/annotations`),
            update: isMe && links.patch('/users/me', updateMeSchema),
            state: isMe && links.get('/users/me/state'),
            update_state: isMe && links.put('/users/me/state', putMyStateSchema),
            api_keys: canManageKeys && links.get('/api-keys'),
            create_api_key: canManageKeys && links.post('/api-keys', createApiKeySchema),
        }),
    };
};

const sendState = (res: Response, state: UserState) => {
    res.setHeader('ETag', `"${state.version}"`);
    res.setHeader('Cache-Control', 'no-store');
    if (state.updatedAt) res.setHeader('Last-Modified', state.updatedAt.toUTCString());
    res.json(state.document);
};

/** `If-Match: "7"` -> 7; `*` or no header -> unconditional */
const parseIfMatch = (header: string | undefined): number | undefined => {
    if (header === undefined || header.trim() === '*') return undefined;
    const m = /^\s*(?:W\/)?"(\d+)"\s*$/.exec(header);
    if (!m) throw new HttpError(400, ['If-Match must be an ETag from GET /users/me/state, e.g. "7"']);
    return Number(m[1]);
};

export const router = (domain: UsersDomain, links: Links): Router => {
    const r = Router();

    r.get('/users/me/state', async (_req, res) => {
        sendState(res, await domain.getMyState(principalOf(res)));
    });

    // the domain enforces the real (64 KB) limit, with a clearer message
    r.put('/users/me/state', express.json({ limit: '256kb', strict: false }), async (req, res) => {
        const ifVersion = parseIfMatch(req.get('If-Match'));
        sendState(res, await domain.putMyState(principalOf(res), req.body, ifVersion));
    });

    r.get('/users/me', async (_req, res) => {
        const actor = principalOf(res);
        res.json(renderUser(links, actor, await domain.getMe(actor)));
    });

    r.patch('/users/me', express.json(), requireValidBody(updateMeSchema), async (req, res) => {
        const body = req.body as { user_name?: string; about_me?: string; info_url?: string | null };
        const actor = principalOf(res);
        const me = await domain.updateMe(actor, {
            userName: body.user_name,
            aboutMe: body.about_me,
            infoUrl: body.info_url,
        });
        res.json(renderUser(links, actor, me));
    });

    r.get('/users/:userId', async (req, res) => {
        const principal = principalOf(res);
        const user = await domain.getUser(principal, toUserId(req.params.userId));
        res.json(renderUser(links, principal, user));
    });

    return r;
};
