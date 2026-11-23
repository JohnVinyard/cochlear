import { createApp } from './app';
import { createFirebaseVerifier } from './auth/adapters/firebase';
import { configFromEnv } from './config';
import { createPool } from './shared/db/pool';

const config = configFromEnv();
const pool = createPool(config.db);
const app = createApp({ config, pool, verifyFirebaseToken: createFirebaseVerifier(config.firebaseProjectId) });

const server = app.listen(config.port, () => {
    console.log(`cochlea api listening on :${config.port} (${config.publicBaseUrl}/v1)`);
});

const shutdown = () => {
    server.close(() => {
        pool.end().finally(() => process.exit(0));
    });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
