import type { ApiKeyId, Role } from '@cochlea/shared';
import { PermissionDenied } from '../shared/errors';
import type { UserId } from '../shared/ids';

export type { Role };

export interface AuthenticatedUser {
    id: UserId;
    userName: string;
}

/**
 * Whoever is making the request, and what they're allowed to do.  Every
 * domain use case receives one.
 */
export type Principal =
    | {
          kind: 'firebase';
          user: AuthenticatedUser;
          roles: ReadonlySet<Role>;
      }
    | {
          kind: 'apiKey';
          user: AuthenticatedUser;
          apiKeyId: ApiKeyId;
          /** Already intersected with the owning user's *current* roles */
          roles: ReadonlySet<Role>;
      };

export const hasRole = (principal: Principal, role: Role): boolean => principal.roles.has(role);

export const requireRole = (principal: Principal, role: Role): void => {
    if (!hasRole(principal, role)) {
        throw new PermissionDenied(`requires role ${role}`);
    }
};

/** Some operations (API key management) are only possible from the web app */
export const requireFirebase = (principal: Principal, action: string): void => {
    if (principal.kind !== 'firebase') {
        throw new PermissionDenied(`${action} is not possible with an API key`);
    }
};

/** Verifies a bearer token and produces a principal, or throws `Unauthenticated` */
export type AuthenticateToken = (token: string) => Promise<Principal>;
