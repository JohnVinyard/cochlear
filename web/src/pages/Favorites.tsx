import { formatSeconds, SoundLink, useSounds } from '../components';
import { StarButton, useFavorites } from '../favorites';

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
                                    <td><StarButton soundId={a.sound_id} span={span} /></td>
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
