/**
 * Builds absolute hrefs for HATEOAS links.  All API paths are expressed
 * relative to the API root, e.g. `/sounds/12`.
 */
export interface Links {
    readonly root: string;
    href(path: string, query?: Record<string, string | number | undefined | null>): string;
}

export const createLinks = (publicBaseUrl: string, prefix = '/v1'): Links => {
    const root = publicBaseUrl.replace(/\/+$/, '') + prefix;
    return {
        root,
        href(path, query) {
            const url = new URL(root + path);
            for (const [k, v] of Object.entries(query ?? {})) {
                if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
            }
            return url.toString();
        },
    };
};
