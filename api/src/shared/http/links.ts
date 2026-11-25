import type { Link, Links as LinkMap } from '@cochlea/shared';

type Query = Record<string, string | number | string[] | undefined | null>;

/** A request body schema, as validated by `requireValidBody` and served at `GET /schemas/{$id}` */
export interface BodySchema {
    $id: string;
}

/**
 * Builds absolute HATEOAS links.  All API paths are expressed relative to
 * the API root, e.g. `/sounds/12`.
 */
export interface Links {
    readonly root: string;
    /** Array values become repeated parameters (`prop=a:x&prop=b:y`) */
    href(path: string, query?: Query): string;
    get(path: string, query?: Query): Link;
    /** A GET link to something outside the API, e.g. a sound's audio */
    external(url: string): Link;
    /** `schema` is omitted for bodies that aren't JSON (e.g. a blob upload) */
    post(path: string, schema?: BodySchema): Link;
    put(path: string, schema: BodySchema): Link;
    patch(path: string, schema: BodySchema): Link;
    delete(path: string): Link;
    /** Where a request body schema is served */
    schemaHref(schema: BodySchema): string;
}

export const createLinks = (publicBaseUrl: string, prefix = '/v1'): Links => {
    const root = publicBaseUrl.replace(/\/+$/, '') + prefix;
    const href = (path: string, query?: Query) => {
        const url = new URL(root + path);
        for (const [k, v] of Object.entries(query ?? {})) {
            for (const item of Array.isArray(v) ? v : [v]) {
                if (item !== undefined && item !== null && item !== '') url.searchParams.append(k, String(item));
            }
        }
        return url.toString();
    };
    const schemaHref = (schema: BodySchema) => href(`/schemas/${encodeURIComponent(schema.$id)}`);
    const withBody = (method: Link['method'], path: string, schema?: BodySchema): Link => ({
        href: href(path),
        method,
        ...(schema ? { schema: schemaHref(schema) } : {}),
    });
    return {
        root,
        href,
        get: (path, query) => ({ href: href(path, query), method: 'GET' }),
        external: (url) => ({ href: url, method: 'GET' }),
        post: (path, schema) => withBody('POST', path, schema),
        put: (path, schema) => withBody('PUT', path, schema),
        patch: (path, schema) => withBody('PATCH', path, schema),
        delete: (path) => ({ href: href(path), method: 'DELETE' }),
        schemaHref,
    };
};

/**
 * Builds a resource's `links`, dropping the ones the requester can't follow:
 * `{ delete: canDelete && links.delete(path) }`.
 */
export const linkMap = (entries: Record<string, Link | false | null | undefined>): LinkMap => {
    const out: LinkMap = {};
    for (const [rel, link] of Object.entries(entries)) {
        if (link) out[rel] = link;
    }
    return out;
};
