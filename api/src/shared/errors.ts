/**
 * Domain-level errors.  Domain and persistence code throw these;  only the
 * HTTP adapter layer translates them into status codes.
 */
export abstract class DomainError extends Error {
    constructor(message: string) {
        super(message);
        this.name = new.target.name;
    }
}

/** The request is well-formed, but violates a business rule */
export class InvalidRequest extends DomainError {
    constructor(public readonly reasons: string[]) {
        super(reasons.join('; '));
    }
}

/** No (valid) credentials were supplied */
export class Unauthenticated extends DomainError {
    constructor(message = 'Authentication required') {
        super(message);
    }
}

/** Valid credentials, insufficient privileges */
export class PermissionDenied extends DomainError {
    constructor(action: string) {
        super(`Permission denied: ${action}`);
    }
}

export class NotFound extends DomainError {
    constructor(what: string) {
        super(`${what} not found`);
    }
}

/** The resource existed, but has been deleted */
export class Gone extends DomainError {
    constructor(what: string) {
        super(`${what} has been deleted`);
    }
}

/** A conflicting resource already exists */
export class Conflict extends DomainError {
    constructor(
        message: string,
        /** Path (relative to the API root) of the conflicting resource, if any */
        public readonly existingPath?: string
    ) {
        super(message);
    }
}
