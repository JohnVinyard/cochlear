import Ajv, { type AnySchema, type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import type { RequestHandler } from 'express';
import { HttpError } from './errors';

export const ajv = new Ajv({ allErrors: true, useDefaults: true, coerceTypes: false });
addFormats(ajv);

const formatErrors = (where: string, errors: ErrorObject[] | null | undefined): string[] =>
    (errors ?? []).map((e) => `${where}${e.instancePath || ''} ${e.message ?? 'is invalid'}`.trim());

/**
 * Validates `req.body` against a JSON schema;  responds `400` on failure.
 */
export const requireValidBody = (schema: AnySchema): RequestHandler => {
    const validate = ajv.compile(schema);
    return (req, _res, next) => {
        if (!validate(req.body)) {
            next(new HttpError(400, formatErrors('body', validate.errors)));
            return;
        }
        next();
    };
};

/**
 * Validates a query-string object (all values are strings) against a JSON
 * schema whose properties are all `type: string` (with patterns).
 */
export const requireValidQuery = (schema: AnySchema): RequestHandler => {
    const validate = ajv.compile(schema);
    return (req, _res, next) => {
        if (!validate({ ...req.query })) {
            next(new HttpError(400, formatErrors('query', validate.errors)));
            return;
        }
        next();
    };
};

// User-supplied schemas (an annotation schema's `json_schema`) get their own
// instance:  they must never be registered by `$id`, and compiled validators
// are cached by content since the schema objects come fresh from the database
const userAjv = new Ajv({ allErrors: true, strict: false, addUsedSchema: false });
addFormats(userAjv);
const userValidators = new Map<string, ReturnType<typeof userAjv.compile>>();
const MAX_CACHED_VALIDATORS = 1000;

const compileUserSchema = (schema: object) => {
    const key = JSON.stringify(schema);
    let validate = userValidators.get(key);
    if (!validate) {
        validate = userAjv.compile(schema);
        if (userValidators.size >= MAX_CACHED_VALIDATORS) userValidators.clear();
        userValidators.set(key, validate);
    }
    return validate;
};

/**
 * Validates arbitrary data against a user-supplied JSON schema.  Returns
 * error messages.
 */
export const validateAgainst = (schema: object, data: unknown): string[] => {
    const validate = compileUserSchema(schema);
    return validate(data) ? [] : formatErrors('data', validate.errors);
};

export const isValidJsonSchema = (schema: object): string[] => {
    try {
        compileUserSchema(schema);
        return [];
    } catch (err) {
        return [`json_schema is not a valid JSON schema: ${(err as Error).message}`];
    }
};
