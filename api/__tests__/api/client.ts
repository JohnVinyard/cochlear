/**
 * Helpers for full-stack API tests. They run against their own API server
 * and database (cochlea_test), which globalSetup starts (environment.ts),
 * using the `docker compose up` stack's Postgres, firebase emulator and fake
 * GCS. Nothing they create reaches the development database.
 *
 *   API_BASE_URL                 set by globalSetup
 *   PGDATABASE                   set by globalSetup (cochlea_test)
 *   FIREBASE_AUTH_EMULATOR_HOST  default localhost:9099
 *   PGHOST/PGPORT/...            default localhost:5432, cochlea/cochlea
 */
import { randomUUID } from 'node:crypto';
import type { Link, Role, UserResource } from '@cochlea/shared';
import pg from 'pg';
import { emulatorSignIn } from '../../src/devtools/firebaseEmulator';

export const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:8080/v1';

export interface ApiResponse<T = any> {
    status: number;
    headers: Headers;
    body: T;
}

/** A path relative to the API root, an absolute URL, or a link (whose href is used) */
export type Target = string | Link;

const hrefOf = (target: Target) => (typeof target === 'string' ? target : target.href);

export class TestClient {
    constructor(private readonly authorization: string | null) {}

    static anonymous() {
        return new TestClient(null);
    }

    static withToken(token: string) {
        return new TestClient(`Bearer ${token}`);
    }

    static withAuthorizationHeader(value: string) {
        return new TestClient(value);
    }

    async request<T = any>(
        method: string,
        target: Target,
        body?: unknown,
        headers: Record<string, string> = {}
    ): Promise<ApiResponse<T>> {
        const pathOrUrl = hrefOf(target);
        const url = pathOrUrl.startsWith('http') ? pathOrUrl : API_BASE_URL + pathOrUrl;
        const isRaw = body instanceof Uint8Array || typeof body === 'string';
        const res = await fetch(url, {
            method,
            headers: {
                ...(this.authorization ? { authorization: this.authorization } : {}),
                ...(body !== undefined && !isRaw ? { 'content-type': 'application/json' } : {}),
                ...headers,
            },
            body: body === undefined ? undefined : isRaw ? (body as BodyInit) : JSON.stringify(body),
        });
        const text = await res.text();
        let parsed: unknown = text;
        try {
            parsed = text ? JSON.parse(text) : null;
        } catch {
            /* not json */
        }
        return { status: res.status, headers: res.headers, body: parsed as T };
    }

    get = <T = any>(target: Target) => this.request<T>('GET', target);
    post = <T = any>(target: Target, body?: unknown, headers?: Record<string, string>) =>
        this.request<T>('POST', target, body, headers);
    put = <T = any>(target: Target, body?: unknown, headers?: Record<string, string>) =>
        this.request<T>('PUT', target, body, headers);
    patch = <T = any>(target: Target, body?: unknown) => this.request<T>('PATCH', target, body);
    delete = <T = any>(target: Target) => this.request<T>('DELETE', target);

    /** Does what a link says, failing the test if there is no such link */
    follow = <T = any>(link: Link | undefined, body?: unknown, headers?: Record<string, string>) => {
        expect(link).toBeDefined();
        return this.request<T>(link!.method, link!, body, headers);
    };

    /** Follows `next` links until exhausted, returning every item */
    async walk<T = any>(target: Target): Promise<T[]> {
        const items: T[] = [];
        let next: Target | undefined = target;
        while (next) {
            const res: ApiResponse = await this.get(next);
            expect(res.status).toBe(200);
            items.push(...res.body.items);
            next = res.body.next;
        }
        return items;
    }
}

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

let pool: pg.Pool | null = null;

export const db = () =>
    (pool ??= new pg.Pool({
        host: process.env.PGHOST ?? 'localhost',
        port: Number(process.env.PGPORT ?? 5432),
        user: process.env.PGUSER ?? 'cochlea',
        password: process.env.PGPASSWORD ?? 'cochlea',
        database: process.env.PGDATABASE ?? 'cochlea',
        max: 2,
    }));

export const closeDb = async () => {
    await pool?.end();
    pool = null;
};

export interface TestUser {
    id: number;
    email: string;
    userName: string;
    token: string;
    client: TestClient;
}

export const uniqueSuffix = () => randomUUID().slice(0, 8);

/** Signs up a brand new firebase emulator user, and provisions them in the API */
export const newUser = async (prefix = 'test'): Promise<TestUser> => {
    const email = `${prefix}-${uniqueSuffix()}@example.com`;
    const session = await emulatorSignIn(email);
    const client = TestClient.withToken(session.idToken);
    const me = await client.get<UserResource>('/users/me');
    expect(me.status).toBe(200);
    return { id: me.body.id, email, userName: me.body.user_name, token: session.idToken, client };
};

export const grantRole = async (user: TestUser, role: Role) => {
    await db().query('insert into user_roles (user_id, role) values ($1, $2) on conflict do nothing', [user.id, role]);
};

export const revokeRole = async (user: TestUser, role: Role) => {
    await db().query('delete from user_roles where user_id = $1 and role = $2', [user.id, role]);
};

export const createApiKey = async (user: TestUser, roles: Role[]): Promise<TestClient> => {
    const res = await user.client.post('/api-keys', { name: 'test key', roles });
    expect(res.status).toBe(201);
    return TestClient.withToken(res.body.secret);
};

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

export const LICENSE = 'https://creativecommons.org/licenses/by/4.0';

export const soundBody = (overrides: Record<string, unknown> = {}) => ({
    audio_url: `https://example.com/test/${uniqueSuffix()}.wav`,
    license_type: LICENSE,
    duration_seconds: 10,
    title: 'a test sound',
    ...overrides,
});

export const createSound = async (user: TestUser, overrides: Record<string, unknown> = {}) => {
    const res = await user.client.post('/sounds', soundBody(overrides));
    expect(res.status).toBe(201);
    return res.body;
};

export const tags = (t: string[], access: unknown = '*', extra: Record<string, unknown> = {}) => ({
    schema: 'tags@1',
    tags: t,
    access,
    ...extra,
});
