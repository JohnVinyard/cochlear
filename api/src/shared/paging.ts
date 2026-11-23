/**
 * Domain-level description of a "feed" request: items with `id > lowId`,
 * oldest first.
 */
export interface FeedRequest<TId extends number> {
    lowId: TId | null;
    pageSize: number;
}

export interface FeedPage<T> {
    items: T[];
    /** True when at least one more item exists after the last one returned */
    hasMore: boolean;
}

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 500;
