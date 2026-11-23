import type { ApiKeyResource, CreatedApiKeyResource } from '@cochlea/shared';
import express, { Router } from 'express';
import { principalOf } from '../../auth/adapters/express';
import type { Links } from '../../shared/http/links';
import { requireValidBody } from '../../shared/http/validation';
import { toApiKeyId } from '../../shared/ids';
import type { ApiKey, ApiKeysDomain, CreateApiKeyModel } from '../domain';
import createApiKeySchema from './createApiKeyRequestBody.schema.json';

const renderApiKey = (links: Links, key: ApiKey): ApiKeyResource => ({
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    roles: key.roles,
    created_at: key.createdAt.toISOString(),
    links: { self: links.href(`/api-keys/${key.id}`), user: links.href(`/users/${key.userId}`) },
});

export const router = (domain: ApiKeysDomain, links: Links): Router => {
    const r = Router();

    r.get('/api-keys', async (_req, res) => {
        const keys = await domain.listApiKeys(principalOf(res));
        res.json({ items: keys.map((k) => renderApiKey(links, k)), links: { self: links.href('/api-keys') } });
    });

    r.post('/api-keys', express.json(), requireValidBody(createApiKeySchema), async (req, res) => {
        const created = await domain.createApiKey(principalOf(res), req.body as CreateApiKeyModel);
        const body: CreatedApiKeyResource = { ...renderApiKey(links, created), secret: created.secret };
        res.status(201).location(body.links.self!).json(body);
    });

    r.delete('/api-keys/:apiKeyId', async (req, res) => {
        await domain.deleteApiKey(principalOf(res), toApiKeyId(req.params.apiKeyId));
        res.status(204).end();
    });

    return r;
};
