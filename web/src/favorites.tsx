import type { AnnotationResource, Page, UserResource } from '@cochlea/shared';
import { onAuthStateChanged } from 'firebase/auth';
import { useEffect, useSyncExternalStore } from 'react';
import { api, follow } from './api';
import { auth } from './auth';

/**
 * Favorites ("stars"): each is the signed-in user's own private favorite@1
 * annotation of a sound (no segment) or of a segment of one. There are no
 * endpoints of their own: starring creates one, unstarring deletes it, and
 * "my favorites" is GET /users/{me}/annotations?schema=favorite@1.
 *
 * Every star on a page needs to know whether its sound or segment is
 * starred, so all of the user's favorites are loaded once, kept here, and
 * updated as they star and unstar (fine up to a few thousand favorites).
 */

export const FAVORITE_SCHEMA = 'favorite@1';

export interface Span {
    start_seconds: number;
    duration_seconds: number;
}

/** What a favorite points at: a sound, or a segment of one */
export const favoriteKey = (soundId: number, span: Span | null) =>
    span ? `${soundId}@${span.start_seconds.toFixed(4)}+${span.duration_seconds.toFixed(4)}` : `${soundId}`;

const keyOf = (a: AnnotationResource) =>
    favoriteKey(
        a.sound_id,
        a.start_seconds === null || a.duration_seconds === null
            ? null
            : { start_seconds: a.start_seconds, duration_seconds: a.duration_seconds }
    );

interface State {
    status: 'idle' | 'loading' | 'ready' | 'error';
    /** Newest first */
    favorites: AnnotationResource[];
    byKey: Map<string, AnnotationResource[]>;
    /** Keys being starred or unstarred right now */
    pending: Set<string>;
}

const empty = (): State => ({ status: 'idle', favorites: [], byKey: new Map(), pending: new Set() });

let state: State = empty();
const listeners = new Set<() => void>();

const set = (next: Partial<State>) => {
    state = { ...state, ...next };
    if (next.favorites) {
        const byKey = new Map<string, AnnotationResource[]>();
        for (const a of next.favorites) byKey.set(keyOf(a), [...(byKey.get(keyOf(a)) ?? []), a]);
        state.byKey = byKey;
    }
    listeners.forEach((l) => l());
};

let loading: Promise<void> | null = null;

const load = (): Promise<void> =>
    (loading ??= (async () => {
        set({ status: 'loading' });
        try {
            const me = await api<UserResource>('/users/me');
            const all: AnnotationResource[] = [];
            let next: string | undefined = `/users/${me.id}/annotations?schema=${FAVORITE_SCHEMA}&page_size=500`;
            while (next) {
                const page: Page<AnnotationResource> = await api<Page<AnnotationResource>>(next);
                all.push(...page.items);
                next = page.next;
            }
            set({ status: 'ready', favorites: all.reverse() });
        } catch {
            loading = null;
            set({ status: 'error' });
        }
    })());

// another user signing in has other favorites. (Firebase also calls this once at
// startup, with the same user: that mustn't throw away a load in progress.)
let uid: string | null | undefined;
onAuthStateChanged(auth, (user) => {
    const next = user?.uid ?? null;
    if (uid !== undefined && next !== uid) {
        loading = null;
        set({ ...empty() });
        if (next && listeners.size) void load(); // stars on screen: load the new user's
    }
    uid = next;
});

/** Stars or unstars a sound or a segment of it. Unstarring removes every matching favorite (two tabs can both star). */
export const toggleFavorite = async (soundId: number, span: Span | null): Promise<void> => {
    await load();
    const key = favoriteKey(soundId, span);
    if (state.pending.has(key)) return;
    set({ pending: new Set(state.pending).add(key) });
    try {
        const existing = state.byKey.get(key) ?? [];
        if (existing.length) {
            await Promise.all(existing.map((a) => follow(a.links.delete!)));
            const gone = new Set(existing.map((a) => a.id));
            set({ favorites: state.favorites.filter((a) => !gone.has(a.id)) });
        } else {
            const created = await api<Page<AnnotationResource>>(`/sounds/${soundId}/annotations`, {
                method: 'POST',
                body: { annotations: [{ schema: FAVORITE_SCHEMA, tags: ['favorite'], access: null, ...(span ?? {}) }] },
            });
            set({ favorites: [...created.items, ...state.favorites] });
        }
    } finally {
        const pending = new Set(state.pending);
        pending.delete(key);
        set({ pending });
    }
};

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

/** The signed-in user's favorites, loaded on first use */
export const useFavorites = (): State => {
    const snapshot = useSyncExternalStore(subscribe, () => state);
    useEffect(() => {
        void load();
    }, []);
    return snapshot;
};

/** A ☆/★ toggle for a sound, or a segment of one */
export const StarButton = ({ soundId, span = null, what }: { soundId: number; span?: Span | null; what?: string }) => {
    const { byKey, pending, status } = useFavorites();
    const key = favoriteKey(soundId, span);
    const starred = byKey.has(key);
    const label = `${starred ? 'Unstar' : 'Star'} this ${what ?? (span ? 'segment' : 'sound')}`;
    return (
        <button
            type="button"
            className={`star${starred ? ' starred' : ''}`}
            aria-pressed={starred}
            aria-label={label}
            title={label}
            disabled={status !== 'ready' || pending.has(key)}
            onClick={(e) => {
                e.stopPropagation(); // e.g. a table row that plays its annotation
                void toggleFavorite(soundId, span);
            }}
        >
            {starred ? '★' : '☆'}
        </button>
    );
};
