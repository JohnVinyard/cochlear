import cors from 'cors';
import express, { type Express, Router } from 'express';
import morgan from 'morgan';
import type pg from 'pg';
import { buildAnnotationSchemas, router as annotationSchemasRouter } from './annotationSchemas';
import { annotationSchemaPolicy } from './annotationSchemas/domain';
import { buildAnnotations, router as annotationsRouter } from './annotations';
import { annotationPolicy } from './annotations/domain';
import { buildApiKeys, isApiKeySecret, router as apiKeysRouter } from './apiKeys';
import { apiKeyPolicy } from './apiKeys/domain';
import { authenticate, principalOf } from './auth/adapters/express';
import type { AuthenticateToken } from './auth/domain';
import { buildBlobs, router as blobsRouter } from './blobs';
import { blobPolicy } from './blobs/domain';
import type { Config } from './config';
import { REQUEST_SCHEMAS, SCHEMAS, servedSchema } from './openapi/requestSchemas';
import { buildOpenApiSpec } from './openapi/spec';
import { Unauthenticated } from './shared/errors';
import { errorHandler, HttpError, notFoundHandler } from './shared/http/errors';
import { createLinks, linkMap } from './shared/http/links';
import { buildSounds, router as soundsRouter } from './sounds';
import { soundPolicy } from './sounds/domain';
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
    // the request body schemas that action links point to
    v1.get('/schemas/:name', (req, res) => {
        const schema = REQUEST_SCHEMAS.get(req.params.name);
        if (!schema) throw new HttpError(404, [`No such schema: ${req.params.name}`]);
        res.set('Cache-Control', 'public, max-age=300');
        res.json(servedSchema(schema, links.schemaHref(schema)));
    });

    v1.use(authenticate(authenticateToken));
    // what this requester can do, starting out
    v1.get('/', (_req, res) => {
        const actor = principalOf(res);
        const canManageKeys = apiKeyPolicy.manage(actor);
        res.json({
            links: linkMap({
                self: links.get('/'),
                me: links.get('/users/me'),
                openapi: links.get('/openapi.json'),
                sounds: soundPolicy.read(actor) && links.get('/sounds'),
                create_sound: soundPolicy.create(actor) && links.post('/sounds', SCHEMAS.createSound),
                annotations: annotationPolicy.read(actor) && links.get('/annotations'),
                annotation_schemas: annotationSchemaPolicy.read(actor) && links.get('/annotation-schemas'),
                create_annotation_schema:
                    annotationSchemaPolicy.create(actor) && links.post('/annotation-schemas', SCHEMAS.createAnnotationSchema),
                api_keys: canManageKeys && links.get('/api-keys'),
                create_api_key: canManageKeys && links.post('/api-keys', SCHEMAS.createApiKey),
                // the body is the blob itself, with its Content-Type
                upload_blob: blobPolicy.upload(actor) && links.post('/blobs'),
            }),
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
