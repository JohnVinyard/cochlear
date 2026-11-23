import type { RequestHandler, Response } from 'express';
import type { AuthenticateToken, Principal } from '../domain';
import { Unauthenticated } from '../../shared/errors';

const BEARER = /^Bearer\s+(\S+)\s*$/i;

export interface AuthenticatedLocals {
    principal: Principal;
}

/**
 * Requires `Authorization: Bearer <firebase id token | api key>` on every
 * request, storing the resulting principal in `res.locals.principal`.
 */
export const authenticate =
    (authenticateToken: AuthenticateToken): RequestHandler =>
    async (req, res, next) => {
        try {
            const match = BEARER.exec(req.header('authorization') ?? '');
            if (!match?.[1]) {
                throw new Unauthenticated();
            }
            (res.locals as AuthenticatedLocals).principal = await authenticateToken(match[1]);
            next();
        } catch (err) {
            next(err);
        }
    };

export const principalOf = (res: Response): Principal => {
    const principal = (res.locals as Partial<AuthenticatedLocals>).principal;
    if (!principal) {
        throw new Unauthenticated();
    }
    return principal;
};
