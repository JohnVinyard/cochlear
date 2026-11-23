/**
 * Test helpers for domain unit tests (not used by production code).
 */
import { ROLES, type Role } from '@cochlea/shared';
import type { Principal } from './auth/domain';
import type { UserId } from './shared/ids';

export const firebasePrincipal = (id: number, roles: readonly Role[] = ROLES): Principal => ({
    kind: 'firebase',
    user: { id: id as UserId, userName: `user${id}` },
    roles: new Set(roles),
});

export const apiKeyPrincipal = (id: number, roles: readonly Role[]): Principal => ({
    kind: 'apiKey',
    apiKeyId: 1 as never,
    user: { id: id as UserId, userName: `user${id}` },
    roles: new Set(roles),
});
