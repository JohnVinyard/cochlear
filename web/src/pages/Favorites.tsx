import type { SoundResource } from '@cochlea/shared';
import { useEffect, useRef, useState } from 'react';
import { playSound, stopPlaying, type Playing, type Span } from '../audio/playback';
import { formatSeconds, SoundLink, useSounds } from '../components';
import { StarButton, useFavorites } from '../favorites';
import { recordPlay } from '../score/store';

/** ▶ plays the favorite (its segment, or the whole sound); ■ stops it */
const PlayButton = ({ sound, span }: { sound: SoundResource | undefined; span: Span | null }) => {
    const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle');
    const [error, setError] = useState<string | null>(null);
    const playing = useRef<Playing | null>(null);
    // leaving the page stops it
    useEffect(() => () => playing.current?.stop(), []);

    const what = span ? 'segment' : 'sound';
    const label = error ? `Couldn't play this ${what}: ${error}` : state === 'idle' ? `Play this ${what}` : 'Stop';
    const toggle = async (timeStamp: number) => {
        if (!sound) return;
        if (state !== 'idle') {
            if (playing.current) playing.current.stop();
            else stopPlaying(); // still loading
            return;
        }
        setError(null);
        setState('loading');
        recordPlay({
            audioUrl: sound.audio_url,
            soundId: sound.id,
            title: sound.title,
            startSeconds: span?.start_seconds ?? 0,
            durationSeconds: span?.duration_seconds ?? sound.duration_seconds,
            source: 'annotation',
            timeStamp,
        });
        try {
            const p = (playing.current = await playSound(sound, span));
            setState('playing');
            await p.ended;
        } catch (e) {
            setError((e as Error).message);
        } finally {
            playing.current = null;
            setState('idle');
        }
    };
    return (
        <button
            type="button"
            className={`play${error ? ' failed' : ''}`}
            aria-label={label}
            title={label}
            disabled={!sound}
            onClick={(e) => void toggle(e.timeStamp)}
        >
            {state === 'idle' ? '▶' : '■'}
        </button>
    );
};

/** The signed-in user's favorites, newest first */
export const FavoritesPage = () => {
    const { favorites, status } = useFavorites();
    const sounds = useSounds(favorites.map((a) => a.links.sound!.href));
    return (
        <>
            <h1>Favorites</h1>
            <p className="muted">
                Sounds and segments you've starred. Star a sound on its page, or a segment in an annotation table or a
                similarity search. Only you can see them.
            </p>
            {status === 'loading' && <p className="muted">Loading…</p>}
            {status === 'error' && <p className="error">Couldn't load your favorites.</p>}
            {status === 'ready' && !favorites.length && <p className="muted">Nothing starred yet.</p>}
            {favorites.length > 0 && (
                <table>
                    <thead>
                        <tr>
                            <th />
                            <th>sound</th>
                            <th>segment</th>
                            <th>starred</th>
                        </tr>
                    </thead>
                    <tbody>
                        {favorites.map((a) => {
                            const span =
                                a.start_seconds === null || a.duration_seconds === null
                                    ? null
                                    : { start_seconds: a.start_seconds, duration_seconds: a.duration_seconds };
                            return (
                                <tr key={a.id}>
                                    <td className="nowrap">
                                        <StarButton soundId={a.sound_id} span={span} />
                                        <PlayButton sound={sounds.get(a.links.sound!.href)} span={span} />
                                    </td>
                                    <td><SoundLink href={a.links.sound!.href} id={a.sound_id} sound={sounds.get(a.links.sound!.href)} /></td>
                                    <td>{span ? `${formatSeconds(a.start_seconds)} – ${formatSeconds(a.end_seconds)}` : 'whole sound'}</td>
                                    <td>{new Date(a.created_at).toLocaleString()}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
        </>
    );
};
