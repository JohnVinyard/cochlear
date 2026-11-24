import type { Request } from 'express';
import { DEFAULT_PAGE_SIZE, type FeedPage, type FeedRequest } from '../paging';
import type { Links } from './links';

export const feedQuerySchemaProperties = {
    low_id: { type: 'string', pattern: '^[0-9]+$' },
    page_size: { type: 'string', pattern: '^(?:[1-9][0-9]{0,1}|[1-4][0-9]{2}|500)$' },
} as const;

export const parseFeedRequest = <TId extends number>(req: Request): FeedRequest<TId> => {
    const q = req.query as Record<string, string | undefined>;
    return {
        lowId: q.low_id ? (Number(q.low_id) as TId) : null,
        pageSize: q.page_size ? Number(q.page_size) : DEFAULT_PAGE_SIZE,
    };
};

/**
 * Renders a feed page as `{items, next?, links}`, where `next` repeats the
 * current query with `low_id` advanced to the last item returned.
 */
export const renderFeedPage = <T extends { id: number }, R>(
    req: Request,
    links: Links,
    path: string,
    page: FeedPage<T>,
    render: (item: T) => R
) => {
    const query = { ...(req.query as Record<string, string | string[]>) };
    const self = links.href(path, query);
    const last = page.items[page.items.length - 1];
    const next =
        page.hasMore && last ? links.href(path, { ...query, low_id: last.id }) : undefined;
    return {
        items: page.items.map(render),
        ...(next ? { next } : {}),
        links: { self },
    };
};
