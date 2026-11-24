/**
 * Builds absolute hrefs for HATEOAS links.  All API paths are expressed
 * relative to the API root, e.g. `/sounds/12`.
 */
export interface Links {
    readonly root: string;
    /** Array values become repeated parameters (`prop=a:x&prop=b:y`) */
    href(path: string, query?: Record<string, string | number | string[] | undefined | null>): string;
}

export const createLinks = (publicBaseUrl: string, prefix = '/v1'): Links => {
    const root = publicBaseUrl.replace(/\/+$/, '') + prefix;
    return {
        root,
        href(path, query) {
            const url = new URL(root + path);
            for (const [k, v] of Object.entries(query ?? {})) {
                for (const item of Array.isArray(v) ? v : [v]) {
                    if (item !== undefined && item !== null && item !== '') url.searchParams.append(k, String(item));
                }
            }
            return url.toString();
        },
    };
};
