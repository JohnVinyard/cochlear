import type { UserResource } from '@cochlea/shared';
import express, { Router } from 'express';
import { principalOf } from '../../auth/adapters/express';
import type { Links } from '../../shared/http/links';
import { requireValidBody } from '../../shared/http/validation';
import { toUserId } from '../../shared/ids';
import type { User, UsersDomain } from '../domain';
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
        ...(isMe ? { api_keys: links.href('/api-keys') } : {}),
    },
});

export const router = (domain: UsersDomain, links: Links): Router => {
    const r = Router();

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
