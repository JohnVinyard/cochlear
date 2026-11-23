/** @group api */
import SwaggerParser from '@apidevtools/swagger-parser';
import { closeDb, newUser, TestClient } from './client';

afterAll(closeDb);

const SAMPLE_PARAMS: Record<string, string> = {
    user_id: '999999999',
    api_key_id: '999999999',
    sound_id: '999999999',
    annotation_id: '999999999',
    ref: 'tags@1',
};

describe('openapi spec', () => {
    it('is a valid OpenAPI document', async () => {
        const spec = (await TestClient.anonymous().get('/openapi.json')).body;
        await expect(SwaggerParser.validate(structuredClone(spec))).resolves.toBeDefined();
        expect(spec.servers[0].url).toMatch(/\/v1$/);
    });

    it('describes only routes that exist', async () => {
        const spec = (await TestClient.anonymous().get('/openapi.json')).body;
        const user = await newUser();
        const missing: string[] = [];
        for (const [path, item] of Object.entries<Record<string, unknown>>(spec.paths)) {
            const concrete = path.replace(/\{(\w+)\}/g, (_, name) => SAMPLE_PARAMS[name] ?? '1');
            for (const method of ['get', 'post', 'patch', 'delete']) {
                if (!item[method]) continue;
                const res = await user.client.request(method.toUpperCase(), concrete, method === 'get' || method === 'delete' ? undefined : {});
                if (res.status === 404 && String(res.body?.errors?.[0]).startsWith('No such route')) {
                    missing.push(`${method.toUpperCase()} ${path}`);
                }
            }
        }
        expect(missing).toEqual([]);
    });
});
