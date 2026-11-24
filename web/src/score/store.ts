/**
 * The score: a recording of what the user plays, anywhere in the app, as
 * timed events, so a rhythm tapped out in the 3-d plot can be kept (and
 * exported as a codec document, see sprs.ts).
 *
 * Timing: each event's time is the moment of the click that triggered it
 * (the DOM event's high-resolution timeStamp, on the performance clock, made
 * absolute with performance.timeOrigin), not when audio started, which
 * varies with network fetches. That's the time the user meant.
 *
 * Capture: <audio-view> dispatches `audio-view-played` (bubbling) for every
 * play, its own (waveform clicks, its play button) and ours (playAudio's
 * fourth argument is the click's timeStamp), so one document listener
 * records all of them. Players that aren't an <audio-view> (the 3-d plot's
 * SegmentPlayer) call recordPlay themselves.
 *
 * The buffer keeps the last MAX_AGE_MS of events (at most MAX_EVENTS), in
 * localStorage, per signed-in user. It's saved every few seconds and when
 * the tab is hidden; tabs merge their events rather than overwrite them.
 */
import { onAuthStateChanged } from 'firebase/auth';
import { useSyncExternalStore } from 'react';
import { auth } from '../auth';

export const MAX_AGE_MS = 30 * 60 * 1000;
export const MAX_EVENTS = 10_000;
const SAVE_EVERY_MS = 2000;

export type PlaySource = 'waveform' | 'annotation' | 'feature' | 'similar' | 'other';

export interface PlayEvent {
    id: string;
    /** When the user clicked: milliseconds since the epoch, with sub-millisecond precision */
    at: number;
    soundId: number | null;
    audioUrl: string;
    title: string | null;
    startSeconds: number;
    durationSeconds: number;
    source: PlaySource;
}

export interface ScoreState {
    recording: boolean;
    /** Oldest first */
    events: PlayEvent[];
    /** Whose score this is (localStorage is per user); null when signed out */
    uid: string | null;
    /** When it was last cleared (epoch ms): older events, e.g. from another tab, don't come back */
    clearedAt: number;
}

const signedOut: ScoreState = { recording: false, events: [], uid: null, clearedAt: 0 };
let state: ScoreState = signedOut;
const listeners = new Set<() => void>();
let dirty = false;

const emit = () => listeners.forEach((l) => l());

/** A DOM event's timeStamp (or now), as epoch milliseconds */
export const epochMs = (timeStamp?: number) => performance.timeOrigin + (timeStamp ?? performance.now());

const storageKey = (uid: string) => `cochlea.score.v1.${uid}`;

/** Drops what's too old (or cleared), and keeps at most MAX_EVENTS (the newest), sorted by time */
const prune = (events: PlayEvent[], clearedAt = state.clearedAt): PlayEvent[] => {
    const cutoff = Math.max(Date.now() - MAX_AGE_MS, clearedAt);
    const kept = events.filter((e) => e.at >= cutoff).sort((a, b) => a.at - b.at);
    return kept.length > MAX_EVENTS ? kept.slice(kept.length - MAX_EVENTS) : kept;
};

const merge = (a: PlayEvent[], b: PlayEvent[], clearedAt: number) =>
    prune([...new Map([...a, ...b].map((e) => [e.id, e])).values()], clearedAt);

interface Stored {
    recording: boolean;
    events: PlayEvent[];
    clearedAt: number;
}

const read = (uid: string): Stored => {
    try {
        const raw = JSON.parse(localStorage.getItem(storageKey(uid)) ?? 'null');
        if (raw && Array.isArray(raw.events)) {
            return { recording: !!raw.recording, events: raw.events, clearedAt: Number(raw.clearedAt) || 0 };
        }
    } catch {
        /* unavailable, or unreadable: start empty */
    }
    return { recording: false, events: [], clearedAt: 0 };
};

const write = (uid: string, stored: Stored) => localStorage.setItem(storageKey(uid), JSON.stringify(stored));

/** Writes the buffer, merged with whatever another tab has written since */
const save = () => {
    const uid = state.uid;
    if (!uid || !dirty) return;
    dirty = false;
    try {
        const stored = read(uid);
        const clearedAt = Math.max(stored.clearedAt, state.clearedAt);
        const events = merge(stored.events, state.events, clearedAt);
        write(uid, { recording: state.recording, events, clearedAt });
        if (events.length !== state.events.length || clearedAt !== state.clearedAt) {
            state = { ...state, events, clearedAt };
            emit();
        }
    } catch {
        /* storage full or unavailable: the in-memory score still works */
    }
};

const set = (next: Partial<ScoreState>) => {
    state = { ...state, ...next };
    dirty = true;
    emit();
};

// load each user's own score
onAuthStateChanged(auth, (user) => {
    save();
    const uid = user?.uid ?? null;
    if (uid) {
        const stored = read(uid);
        state = { uid, ...stored, events: prune(stored.events, stored.clearedAt) };
    } else {
        state = signedOut;
    }
    dirty = false;
    emit();
});

setInterval(save, SAVE_EVERY_MS);
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && save());
window.addEventListener('pagehide', save);
// another tab recorded something: take its events too
window.addEventListener('storage', (e) => {
    if (!state.uid || e.key !== storageKey(state.uid)) return;
    const stored = read(state.uid);
    const clearedAt = Math.max(stored.clearedAt, state.clearedAt);
    state = { ...state, recording: stored.recording, clearedAt, events: merge(state.events, stored.events, clearedAt) };
    emit();
});

// ---------------------------------------------------------------------------
// recording
// ---------------------------------------------------------------------------

/** What's known about sounds by their audio URL, for naming the plays <audio-view> reports */
const sounds = new Map<string, { id: number; title: string | null }>();

export const registerSound = (s: { id: number; audio_url: string; title: string | null }) =>
    sounds.set(s.audio_url, { id: s.id, title: s.title });

export const recordPlay = (play: Omit<PlayEvent, 'id' | 'at' | 'soundId' | 'title'> & {
    /** The triggering DOM event's timeStamp, for the most precise time; else now */
    timeStamp?: number;
    soundId?: number | null;
    title?: string | null;
}) => {
    if (!state.recording || !state.uid) return;
    const known = sounds.get(play.audioUrl);
    const { timeStamp, ...rest } = play;
    const event: PlayEvent = {
        ...rest,
        id: crypto.randomUUID(),
        at: epochMs(timeStamp),
        soundId: play.soundId ?? known?.id ?? null,
        title: play.title ?? known?.title ?? null,
    };
    set({ events: prune([...state.events, event]) });
};

/**
 * Plays that are about to happen through <audio-view> can say where they came
 * from; anything it plays without being told is the user using it directly.
 */
let nextSource: PlaySource | null = null;
export const announceSource = (source: PlaySource) => {
    nextSource = source;
};

document.addEventListener('audio-view-played', (e) => {
    const { url, startSeconds, durationSeconds, eventTime } = (e as CustomEvent).detail ?? {};
    if (typeof url !== 'string') return;
    const source = nextSource ?? 'waveform';
    nextSource = null;
    recordPlay({
        audioUrl: url,
        startSeconds: Number(startSeconds) || 0,
        durationSeconds: Number(durationSeconds) || 0,
        source,
        // seconds on the performance clock, or 0 when the caller passed no time
        timeStamp: eventTime ? eventTime * 1000 : undefined,
    });
});

export const setRecording = (recording: boolean) => {
    set({ recording });
    save();
};

export const clearScore = () => {
    const uid = state.uid;
    if (!uid) return;
    state = { ...state, events: [], clearedAt: Date.now() };
    try {
        write(uid, { recording: state.recording, events: [], clearedAt: state.clearedAt });
        dirty = false;
    } catch {
        dirty = true; /* the in-memory score is cleared regardless */
    }
    emit();
};

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

export const useScore = (): ScoreState => useSyncExternalStore(subscribe, () => state);
