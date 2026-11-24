import { LICENSE_TYPES, type AnnotationResource, type Page, type SoundResource, type UserResource } from '@cochlea/shared';
import { useCallback, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api, ApiError, appPath, useFeed, useResource } from '../api';
import { AnnotationTable, ApiLink, ErrorMessage, LicenseBadge, LoadMore } from '../components';
import { AnnotationTimeline } from '../elements/AnnotationTimeline';
import { AudioView, playSpan } from '../elements/AudioView';
import { SoundTimeseries } from '../elements/TimeseriesViews';
import { SimilarSegments, VectorLanes } from '../vectors/VectorSearch';
import { StarButton } from '../favorites';
import type { AudioViewElement } from '../elements/web-components';

export const SoundsPage = () => {
    const { userId } = useParams();
    const feed = useFeed<SoundResource>(userId ? `/users/${userId}/sounds` : '/sounds');
    return (
        <>
            <h1>{userId ? `Sounds by user ${userId}` : 'Sounds'}</h1>
            {!userId && <CreateSound />}
            <ErrorMessage error={feed.error} />
            <table>
                <thead>
                    <tr><th /><th>id</th><th>title</th><th>duration</th><th>license</th><th>audio</th><th>by</th></tr>
                </thead>
                <tbody>
                    {feed.items.map((s) => (
                        <tr key={s.id}>
                            <td><StarButton soundId={s.id} /></td>
                            <td><ApiLink href={s.links.self!}>{s.id}</ApiLink></td>
                            <td><ApiLink href={s.links.self!}>{s.title ?? <em>untitled</em>}</ApiLink></td>
                            <td>{s.duration_seconds.toFixed(2)}s</td>
                            <td><LicenseBadge license={s.license_type} compact /></td>
                            <td className="truncate"><a href={s.audio_url}>{s.audio_url}</a></td>
                            <td><ApiLink href={s.links.created_by!}>user {s.created_by}</ApiLink></td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <LoadMore hasMore={feed.hasMore} loadMore={feed.loadMore} />
        </>
    );
};

/** Reads an audio file's duration in the browser */
const probeDuration = (url: string) =>
    new Promise<number>((resolve, reject) => {
        const audio = new Audio();
        audio.preload = 'metadata';
        audio.onloadedmetadata = () => resolve(audio.duration);
        audio.onerror = () => reject(new Error('Could not load audio to determine its duration'));
        audio.src = url;
    });

const CreateSound = () => {
    const navigate = useNavigate();
    const [form, setForm] = useState({ audio_url: '', title: '', info_url: '', license_type: LICENSE_TYPES[0] as string, duration_seconds: '' });
    const [error, setError] = useState<Error | null>(null);
    const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
        setForm((f) => ({ ...f, [k]: e.target.value }));

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        try {
            const duration = form.duration_seconds ? Number(form.duration_seconds) : await probeDuration(form.audio_url);
            const sound = await api<SoundResource>('/sounds', {
                method: 'POST',
                body: {
                    audio_url: form.audio_url,
                    title: form.title || null,
                    info_url: form.info_url || null,
                    license_type: form.license_type,
                    duration_seconds: duration,
                },
            });
            navigate(appPath(sound.links.self!));
        } catch (err) {
            setError(err as Error);
        }
    };

    return (
        <details className="panel">
            <summary>Register a sound</summary>
            <form onSubmit={submit} className="stack">
                <label>Audio URL <input type="url" required value={form.audio_url} onChange={set('audio_url')} /></label>
                <label>Title <input value={form.title} onChange={set('title')} /></label>
                <label>Info URL <input type="url" value={form.info_url} onChange={set('info_url')} /></label>
                <label>License
                    <select value={form.license_type} onChange={set('license_type')}>
                        {LICENSE_TYPES.map((l) => <option key={l} value={l}>{l}</option>)}
                    </select>
                </label>
                <label>Duration (seconds; detected from the audio if blank)
                    <input type="number" step="any" min="0" value={form.duration_seconds} onChange={set('duration_seconds')} />
                </label>
                <button type="submit">Register</button>
                <ErrorMessage error={error} />
            </form>
        </details>
    );
};

export const SoundPage = () => {
    const { soundId } = useParams();
    const sound = useResource<SoundResource>(`/sounds/${soundId}`);
    const me = useResource<UserResource>('/users/me');
    const annotations = useFeed<AnnotationResource>(`/sounds/${soundId}/annotations?page_size=500`);
    const audioView = useRef<AudioViewElement | null>(null);
    const [view, setView] = useState<'time-series' | 'spectrogram'>('time-series');
    const [query, setQuery] = useState<AnnotationResource | null>(null);

    const play = useCallback(
        (a: AnnotationResource) => {
            // just the annotation's span, not on to the end of the sound
            if (sound.data && audioView.current && a.start_seconds !== null && a.duration_seconds !== null) {
                playSpan(audioView.current, sound.data.audio_url, a.start_seconds, a.duration_seconds);
            }
        },
        [sound.data]
    );

    const playFrom = useCallback(
        (seconds: number) => {
            if (sound.data) {
                const start = Math.max(0, seconds);
                audioView.current?.playAudio(sound.data.audio_url, start, sound.data.duration_seconds - start);
            }
        },
        [sound.data]
    );

    const search = useCallback(
        (a: AnnotationResource) => {
            setQuery(a);
            play(a);
        },
        [play]
    );

    if (sound.error) return <ErrorMessage error={sound.error} />;
    if (!sound.data) return <p>Loading…</p>;
    const s = sound.data;

    const remove = async () => {
        if (!confirm('Delete this sound?')) return;
        await api(s.links.self!, { method: 'DELETE' });
        history.back();
    };

    return (
        <>
            <h1>
                <StarButton soundId={s.id} /> {s.title ?? `Sound ${s.id}`}
            </h1>
            <p className="muted">
                {s.duration_seconds.toFixed(2)}s · <LicenseBadge license={s.license_type} />
                {s.info_url && <> · <a href={s.info_url}>info</a></>} · added by <ApiLink href={s.links.created_by!}>user {s.created_by}</ApiLink>
                {me.data?.id === s.created_by && <> · <button className="link danger" onClick={remove}>delete</button></>}
            </p>
            <SoundFormats sound={s} />
            <div className="row">
                <button className={view === 'time-series' ? '' : 'secondary'} onClick={() => setView('time-series')}>Waveform</button>
                <button className={view === 'spectrogram' ? '' : 'secondary'} onClick={() => setView('spectrogram')}>Spectrogram</button>
            </div>
            <AudioView id={`audio-view-${s.id}`} ref={audioView} src={s.audio_url} view={view} />
            <SoundTimeseries sound={s} audioViewId={`audio-view-${s.id}`} onSelected={playFrom} />
            <VectorLanes sound={s} audioViewId={`audio-view-${s.id}`} selected={query} onSelected={search} />
            <AnnotationTimeline
                duration={s.duration_seconds}
                annotations={annotations.items}
                audioViewId={`audio-view-${s.id}`}
                onSelected={play}
            />
            {query && <SimilarSegments key={query.id} query={query} />}
            <h2>Annotations</h2>
            <AddTags sound={s} onCreated={annotations.reload} />
            <ErrorMessage error={annotations.error} />
            <AnnotationTable items={annotations.items} onSelect={play} showSound={false} />
            <LoadMore hasMore={annotations.hasMore} loadMore={annotations.loadMore} />
        </>
    );
};

/** "1.5 kHz", "128 kbps": metadata values worth formatting; everything else as it is */
const formatMetadata = (key: string, value: unknown): string => {
    if (typeof value === 'number' && key === 'sample_rate') return `${value / 1000} kHz`;
    if (typeof value === 'number' && key === 'bitrate') return `${Math.round(value / 1000)} kbps`;
    if (typeof value === 'number' && key === 'size_bytes') return `${(value / 1e6).toFixed(1)} MB`;
    return `${key.replace(/_/g, ' ')}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`;
};

/** Other encodings of the sound (sound_formats), if it has any */
const SoundFormats = ({ sound }: { sound: SoundResource }) =>
    sound.formats.length ? (
        <p className="muted formats">
            Also as{' '}
            {sound.formats.map((f, i) => (
                <span key={f.id}>
                    {i > 0 && ' · '}
                    <a href={f.url}>{f.mime_type}</a>
                    {Object.keys(f.metadata).length > 0 &&
                        ` (${Object.entries(f.metadata)
                            .map(([k, v]) => formatMetadata(k, v))
                            .join(', ')})`}
                </span>
            ))}
        </p>
    ) : null;

/** The simplest possible annotation editor:  tags, optionally for a segment */
const AddTags = ({ sound, onCreated }: { sound: SoundResource; onCreated: () => void }) => {
    const [tags, setTags] = useState('');
    const [start, setStart] = useState('');
    const [end, setEnd] = useState('');
    const [isPublic, setPublic] = useState(true);
    const [error, setError] = useState<ApiError | null>(null);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        const segment =
            start !== '' && end !== ''
                ? { start_seconds: Number(start), duration_seconds: Math.max(0, Number(end) - Number(start)) }
                : {};
        try {
            await api<Page<AnnotationResource>>(sound.links.annotations!, {
                method: 'POST',
                body: {
                    annotations: [
                        {
                            schema: 'tags@1',
                            tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
                            access: isPublic ? '*' : null,
                            ...segment,
                        },
                    ],
                },
            });
            setTags('');
            onCreated();
        } catch (err) {
            setError(err as ApiError);
        }
    };

    return (
        <form onSubmit={submit} className="row panel">
            <input placeholder="tags, comma separated" required value={tags} onChange={(e) => setTags(e.target.value)} />
            <input placeholder="start (s)" type="number" step="any" min="0" value={start} onChange={(e) => setStart(e.target.value)} />
            <input placeholder="end (s)" type="number" step="any" min="0" value={end} onChange={(e) => setEnd(e.target.value)} />
            <label className="inline"><input type="checkbox" checked={isPublic} onChange={(e) => setPublic(e.target.checked)} /> public</label>
            <button type="submit">Add tags</button>
            <ErrorMessage error={error} />
        </form>
    );
};
