import type { UserResource } from '@cochlea/shared';
import express, { type Response, Router } from 'express';
import { principalOf } from '../../auth/adapters/express';
import type { Links } from '../../shared/http/links';
import { HttpError } from '../../shared/http/errors';
import { requireValidBody } from '../../shared/http/validation';
import { toUserId } from '../../shared/ids';
import type { User, UserState, UsersDomain } from '../domain';
import updateMeSchema from './updateMeRequestBody.schema.json';

export const renderUser = (links: Links, user: User, isMe: boolean): UserResource => ({
    id: user.id,
    user_name: user.userName,
    about_me: user.aboutMe,
    info_url: user.infoUrl,
    created_at: user.createdAt.toISOString(),
    ...(isMe ? { email: user.email, roles: user.roles } : {}),
    links: {
        self: links.href(`/users/${user.id}`),
        sounds: links.href(`/users/${user.id}/sounds`),
        annotations: links.href(`/users/${user.id}/annotations`),
        ...(isMe ? { api_keys: links.href('/api-keys'), state: links.href('/users/me/state') } : {}),
    },
});

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
        const me = await domain.getMe(principalOf(res));
        res.json(renderUser(links, me, true));
    });

    r.patch('/users/me', express.json(), requireValidBody(updateMeSchema), async (req, res) => {
        const body = req.body as { user_name?: string; about_me?: string; info_url?: string | null };
        const me = await domain.updateMe(principalOf(res), {
            userName: body.user_name,
            aboutMe: body.about_me,
            infoUrl: body.info_url,
        });
        res.json(renderUser(links, me, true));
    });

    r.get('/users/:userId', async (req, res) => {
        const principal = principalOf(res);
        const user = await domain.getUser(principal, toUserId(req.params.userId));
        res.json(renderUser(links, user, user.id === principal.user.id));
    });

    return r;
};
