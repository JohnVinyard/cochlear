import type { ErrorRequestHandler, RequestHandler } from 'express';
import {
    Conflict,
    DomainError,
    Gone,
    InvalidRequest,
    NotFound,
    PermissionDenied,
    PreconditionFailed,
    Unauthenticated,
} from '../errors';
import type { Links } from './links';

/**
 * Translates domain errors into HTTP responses.  This is the *only* place
 * status codes for domain errors are decided.
 */
const statusFor = (err: DomainError): number => {
    if (err instanceof InvalidRequest) return 400;
    if (err instanceof Unauthenticated) return 401;
    if (err instanceof PermissionDenied) return 403;
    if (err instanceof NotFound) return 404;
    if (err instanceof Conflict) return 409;
    if (err instanceof Gone) return 410;
    if (err instanceof PreconditionFailed) return 412;
    return 500;
};

/** Thrown by HTTP adapters for problems that never reach the domain */
export class HttpError extends Error {
    constructor(
        public readonly status: number,
        public readonly errors: string[]
    ) {
        super(errors.join('; '));
    }
}

export const errorHandler =
    (links: Links): ErrorRequestHandler =>
    (err, _req, res, _next) => {
        if (err instanceof HttpError) {
            res.status(err.status).json({ errors: err.errors });
            return;
        }
        if (err instanceof DomainError) {
            const status = statusFor(err);
            if (err instanceof Unauthenticated) {
                res.setHeader('WWW-Authenticate', 'Bearer');
            }
            if (err instanceof Conflict && err.existingPath) {
                res.setHeader('Location', links.href(err.existingPath));
            }
            const errors = err instanceof InvalidRequest ? err.reasons : [err.message];
            res.status(status).json({ errors });
            return;
        }
        // body-parser errors (malformed JSON, too large)
        if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
            res.status(err.status).json({ errors: [err.message] });
            return;
        }
        console.error(err);
        res.status(500).json({ errors: ['Internal server error'] });
    };

export const ROUTE_NOT_FOUND = 'No such route';

export const notFoundHandler: RequestHandler = (req, res) => {
    res.status(404).json({ errors: [`${ROUTE_NOT_FOUND}: ${req.method} ${req.path}`] });
};
