import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
    plugins: [react()],
    resolve: {
        // consume the shared package's TypeScript source directly (no build step)
        alias: { '@cochlea/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)) },
    },
    server: { port: 5173, strictPort: true },
    build: {
        rollupOptions: {
            // the API reference is its own page, embedded in an iframe (see src/pages/ApiDocs.tsx)
            input: {
                main: fileURLToPath(new URL('./index.html', import.meta.url)),
                apiReference: fileURLToPath(new URL('./api-reference.html', import.meta.url)),
            },
        },
    },
});
