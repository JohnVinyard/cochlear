import { createHash, randomBytes } from 'node:crypto';
import { API_KEY_GRANTABLE_ROLES, API_KEY_PREFIX, type Role } from '@cochlea/shared';
import { type Principal, requireFirebase, requireRole } from '../auth/domain';
import { InvalidRequest, NotFound, Unauthenticated } from '../shared/errors';
import type { ApiKeyId, UserId } from '../shared/ids';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApiKey {
    id: ApiKeyId;
    userId: UserId;
    name: string;
    prefix: string;
    roles: Role[];
    createdAt: Date;
}

export interface CreatedApiKey extends ApiKey {
    secret: string;
}

export interface CreateApiKeyModel {
    name: string;
    roles: Role[];
}

/** Everything needed to authenticate a request made with a key */
export interface ApiKeyCredentials {
    key: ApiKey;
    userName: string;
    /** The owning user's roles *right now* */
    userRoles: Role[];
}

// ---------------------------------------------------------------------------
// Outgoing ports
// ---------------------------------------------------------------------------

export interface ApiKeysPersistence {
    insert(key: Omit<ApiKey, 'id'> & { hash: string }): Promise<ApiKey>;
    listActive(userId: UserId): Promise<ApiKey[]>;
    /** Returns false if no active key with this id belongs to the user */
    markDeleted(userId: UserId, id: ApiKeyId, deletedAt: Date): Promise<boolean>;
    getActiveByHash(hash: string): Promise<ApiKeyCredentials | null>;
}

// ---------------------------------------------------------------------------
// Incoming ports
// ---------------------------------------------------------------------------

export interface ApiKeysDomain {
    createApiKey(actor: Principal, model: CreateApiKeyModel): Promise<CreatedApiKey>;
    listApiKeys(actor: Principal): Promise<ApiKey[]>;
    deleteApiKey(actor: Principal, id: ApiKeyId): Promise<void>;
    authenticateApiKey(secret: string): Promise<Principal>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export const API_KEY_DISPLAY_PREFIX_LENGTH = 12;

export const generateApiKeySecret = (): string => API_KEY_PREFIX + randomBytes(32).toString('base64url');

export const hashApiKeySecret = (secret: string): string =>
    createHash('sha256').update(secret, 'utf8').digest('hex');

export const isApiKeySecret = (token: string): boolean => token.startsWith(API_KEY_PREFIX);

export const buildApiKeysDomain = (
    persistence: ApiKeysPersistence,
    now: () => Date = () => new Date(),
    generateSecret: () => string = generateApiKeySecret
): ApiKeysDomain => {
    const requireKeyManager = (actor: Principal, action: string) => {
        requireFirebase(actor, action);
        requireRole(actor, 'API_KEY_CREATOR');
    };

    return {
        async createApiKey(actor, model) {
            requireKeyManager(actor, 'creating API keys');
            const name = model.name.trim();
            const errors: string[] = [];
            if (!name || name.length > 255) {
                errors.push('name must be between 1 and 255 characters');
            }
            const roles = [...new Set(model.roles)];
            const ungrantable = roles.filter((r) => !API_KEY_GRANTABLE_ROLES.includes(r));
            if (ungrantable.length) {
                errors.push(`roles may never be granted to an API key: ${ungrantable.join(', ')}`);
            }
            const notHeld = roles.filter((r) => !actor.roles.has(r) && !ungrantable.includes(r));
            if (notHeld.length) {
                errors.push(`you may only grant roles you hold yourself: ${notHeld.join(', ')}`);
            }
            if (!roles.length) {
                errors.push('at least one role is required');
            }
            if (errors.length) throw new InvalidRequest(errors);

            const secret = generateSecret();
            const key = await persistence.insert({
                userId: actor.user.id,
                name,
                prefix: secret.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH),
                roles,
                createdAt: now(),
                hash: hashApiKeySecret(secret),
            });
            return { ...key, secret };
        },

        async listApiKeys(actor) {
            requireKeyManager(actor, 'listing API keys');
            return persistence.listActive(actor.user.id);
        },

        async deleteApiKey(actor, id) {
            requireKeyManager(actor, 'deleting API keys');
            if (!(await persistence.markDeleted(actor.user.id, id, now()))) {
                throw new NotFound(`api key ${id}`);
            }
        },

        async authenticateApiKey(secret) {
            if (!isApiKeySecret(secret)) throw new Unauthenticated('Invalid API key');
            const credentials = await persistence.getActiveByHash(hashApiKeySecret(secret));
            if (!credentials) throw new Unauthenticated('Invalid API key');
            // a key can never do more than its owner can do *today*
            const userRoles = new Set(credentials.userRoles);
            return {
                kind: 'apiKey',
                apiKeyId: credentials.key.id,
                user: { id: credentials.key.userId, userName: credentials.userName },
                roles: new Set(credentials.key.roles.filter((r) => userRoles.has(r))),
            };
        },
    };
};
