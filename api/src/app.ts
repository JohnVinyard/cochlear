import cors from 'cors';
import express, { type Express, Router } from 'express';
import morgan from 'morgan';
import type pg from 'pg';
import { buildAnnotationSchemas, router as annotationSchemasRouter } from './annotationSchemas';
import { buildAnnotations, router as annotationsRouter } from './annotations';
import { buildApiKeys, isApiKeySecret, router as apiKeysRouter } from './apiKeys';
import { authenticate } from './auth/adapters/express';
import type { AuthenticateToken } from './auth/domain';
import { buildBlobs, router as blobsRouter } from './blobs';
import type { Config } from './config';
import { buildOpenApiSpec } from './openapi/spec';
import { Unauthenticated } from './shared/errors';
import { errorHandler, notFoundHandler } from './shared/http/errors';
import { createLinks } from './shared/http/links';
import { buildSounds, router as soundsRouter } from './sounds';
import { buildUsers, router as usersRouter } from './users';

export interface AppDependencies {
    config: Config;
    pool: pg.Pool;
    verifyFirebaseToken: (token: string) => Promise<{ uid: string; email: string | null } | null>;
}

/**
 * Composition root:  wires every feature's domain to its adapters, and
 * mounts the HTTP routers under `/v1`.
 */
export const createApp = ({ config, pool, verifyFirebaseToken }: AppDependencies): Express => {
    const links = createLinks(config.publicBaseUrl);

    const users = buildUsers(pool);
    const apiKeys = buildApiKeys(pool);
    const sounds = buildSounds(pool);
    const schemas = buildAnnotationSchemas(pool);
    const annotations = buildAnnotations(pool, { schemas, sounds, users });
    const blobs = buildBlobs(config.blobs);

    const authenticateToken: AuthenticateToken = async (token) => {
        if (isApiKeySecret(token)) return apiKeys.authenticateApiKey(token);
        const identity = await verifyFirebaseToken(token);
        if (!identity) throw new Unauthenticated('Invalid or expired token');
        return users.principalForFirebaseIdentity(identity);
    };

    const spec = buildOpenApiSpec(links.root);

    const v1 = Router();
    // the only unauthenticated routes
    v1.get('/openapi.json', (_req, res) => {
        res.json(spec);
    });
    v1.get('/health', (_req, res) => {
        res.json({ ok: true });
    });

    v1.use(authenticate(authenticateToken));
    v1.get('/', (_req, res) => {
        res.json({
            links: {
                self: links.href('/'),
                me: links.href('/users/me'),
                sounds: links.href('/sounds'),
                annotations: links.href('/annotations'),
                annotation_schemas: links.href('/annotation-schemas'),
                api_keys: links.href('/api-keys'),
                blobs: links.href('/blobs'),
                openapi: links.href('/openapi.json'),
            },
        });
    });
    v1.use(usersRouter(users, links));
    v1.use(apiKeysRouter(apiKeys, links));
    v1.use(soundsRouter(sounds, links));
    v1.use(annotationSchemasRouter(schemas, links));
    v1.use(annotationsRouter(annotations, links));
    v1.use(blobsRouter(blobs));

    const app = express();
    app.disable('x-powered-by');
    app.set('query parser', 'simple');
    app.use(morgan(process.env.NODE_ENV === 'test' ? 'tiny' : 'dev'));
    app.use(
        cors({
            origin: config.corsOrigins.length ? config.corsOrigins : false,
            exposedHeaders: ['Location', 'WWW-Authenticate'],
        })
    );
    app.use('/v1', v1);
    app.use(notFoundHandler);
    app.use(errorHandler(links));
    return app;
};
