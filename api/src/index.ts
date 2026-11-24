import { createApp } from './app';
import { buildAnnotationSchemas } from './annotationSchemas';
import { createFirebaseVerifier } from './auth/adapters/firebase';
import { configFromEnv } from './config';
import { createPool } from './shared/db/pool';

const config = configFromEnv();
const pool = createPool(config.db);
const app = createApp({ config, pool, verifyFirebaseToken: createFirebaseVerifier(config.firebaseProjectId) });

const server = app.listen(config.port, () => {
    console.log(`cochlea api listening on :${config.port} (${config.publicBaseUrl}/v1)`);
});

// vector schemas get their search index when they're created; this catches
// older ones, and builds that were interrupted. It doesn't block requests.
buildAnnotationSchemas(pool)
    .ensureVectorIndexes()
    .then((created) => created.length && console.log(`created vector indices for ${created.join(', ')}`))
    .catch((err) => console.error('checking vector indices failed:', err));

const shutdown = () => {
    server.close(() => {
        pool.end().finally(() => process.exit(0));
    });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
