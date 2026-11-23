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
});
