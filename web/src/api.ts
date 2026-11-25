import type { ErrorBody, Link, Page } from '@cochlea/shared';
import { useCallback, useEffect, useState } from 'react';
import { auth } from './auth';
import { config } from './config';

export class ApiError extends Error {
    constructor(
        public readonly status: number,
        public readonly errors: string[]
    ) {
        super(errors.join('; ') || `HTTP ${status}`);
    }
}

/** Accepts either an absolute href (from a `links` object) or a path relative to the API root */
const resolve = (hrefOrPath: string) => (hrefOrPath.startsWith('http') ? hrefOrPath : config.apiBaseUrl + hrefOrPath);

export const api = async <T,>(hrefOrPath: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
    const token = await auth.currentUser?.getIdToken();
    const res = await fetch(resolve(hrefOrPath), {
        method: init.method ?? 'GET',
        headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (res.status === 204) return undefined as T;
    const body = (await res.json().catch(() => ({}))) as T | ErrorBody;
    if (!res.ok) throw new ApiError(res.status, (body as ErrorBody).errors ?? []);
    return body as T;
};

/** Does what a link says: its method, at its href, with `body` (which should match `link.schema`) */
export const follow = <T,>(link: Link, body?: unknown): Promise<T> => api<T>(link.href, { method: link.method, body });

/**
 * Translates an API href into the equivalent web app route:  the app's
 * routes mirror the API's resource structure.
 */
export const appPath = (href: string): string => {
    const url = new URL(href);
    const root = new URL(config.apiBaseUrl);
    return url.pathname.slice(root.pathname.length) + url.search || '/';
};

export const useResource = <T,>(hrefOrPath: string | null) => {
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<ApiError | null>(null);
    const [version, setVersion] = useState(0);
    useEffect(() => {
        if (!hrefOrPath) return;
        let cancelled = false;
        setError(null);
        api<T>(hrefOrPath)
            .then((d) => !cancelled && setData(d))
            .catch((e) => !cancelled && setError(e));
        return () => {
            cancelled = true;
        };
    }, [hrefOrPath, version]);
    const reload = useCallback(() => setVersion((v) => v + 1), []);
    return { data, error, reload };
};

/** Accumulates a feed, following `next` links on demand */
export const useFeed = <T,>(hrefOrPath: string) => {
    const [items, setItems] = useState<T[]>([]);
    const [next, setNext] = useState<string | undefined>(undefined);
    const [error, setError] = useState<ApiError | null>(null);
    const [version, setVersion] = useState(0);

    useEffect(() => {
        let cancelled = false;
        setItems([]);
        setError(null);
        api<Page<T>>(hrefOrPath)
            .then((page) => {
                if (cancelled) return;
                setItems(page.items);
                setNext(page.next);
            })
            .catch((e) => !cancelled && setError(e));
        return () => {
            cancelled = true;
        };
    }, [hrefOrPath, version]);

    const loadMore = useCallback(async () => {
        if (!next) return;
        const page = await api<Page<T>>(next);
        setItems((prev) => [...prev, ...page.items]);
        setNext(page.next);
    }, [next]);

    const reload = useCallback(() => setVersion((v) => v + 1), []);
    return { items, hasMore: !!next, loadMore, error, reload };
};
