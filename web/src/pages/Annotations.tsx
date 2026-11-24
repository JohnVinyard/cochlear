import type { AnnotationResource, UserResource } from '@cochlea/shared';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { api, useFeed, useResource } from '../api';
import {
    AccessBadge,
    AnnotationTable,
    AnnotationValue,
    ApiLink,
    ErrorMessage,
    formatSeconds,
    LoadMore,
    SoundLink,
    useSounds,
} from '../components';
import { JsonView } from '../elements/JsonView';

export const AnnotationsPage = () => {
    const { soundId, userId } = useParams();
    const [search, setSearch] = useSearchParams();
    const base = soundId ? `/sounds/${soundId}/annotations` : userId ? `/users/${userId}/annotations` : '/annotations';
    const query = search.toString();
    const feed = useFeed<AnnotationResource>(query ? `${base}?${query}` : base);

    const filter = (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const next = new URLSearchParams();
        for (const key of ['q', 'schema', 'tags']) {
            const v = String(data.get(key) ?? '').trim();
            if (v) next.set(key, v);
        }
        // one prop parameter per line: key:value
        for (const line of String(data.get('prop') ?? '').split('\n')) {
            if (line.trim()) next.append('prop', line.trim());
        }
        setSearch(next);
    };

    return (
        <>
            <h1>{soundId ? `Annotations of sound ${soundId}` : userId ? `Annotations by user ${userId}` : 'Annotations'}</h1>
            {/* keyed by the query, so its fields follow navigation (e.g. clicking a tag) */}
            <form key={search.toString()} className="panel search" onSubmit={filter}>
                <div className="row">
                    <input
                        name="q"
                        className="grow"
                        placeholder='search tags, text and JSON values: words, "a phrase", -excluded, or'
                        defaultValue={search.get('q') ?? ''}
                    />
                    <button type="submit">Search</button>
                </div>
                <div className="row">
                    <input name="schema" placeholder="schema, e.g. musicnet-note@1" defaultValue={search.get('schema') ?? ''} />
                    <input name="tags" placeholder="tags (all of), comma separated" defaultValue={search.get('tags') ?? ''} />
                </div>
                <textarea
                    name="prop"
                    rows={2}
                    placeholder={'JSON properties, one key:value per line (exact, case-sensitive), e.g.\ninstrument_name:Piano'}
                    defaultValue={search.getAll('prop').join('\n')}
                />
            </form>
            <ErrorMessage error={feed.error} />
            <AnnotationTable items={feed.items} showSound={!soundId} />
            <LoadMore hasMore={feed.hasMore} loadMore={feed.loadMore} />
        </>
    );
};

export const AnnotationPage = () => {
    const { annotationId } = useParams();
    const navigate = useNavigate();
    const annotation = useResource<AnnotationResource>(`/annotations/${annotationId}`);
    const me = useResource<UserResource>('/users/me');
    const sounds = useSounds(annotation.data ? [annotation.data.links.sound!] : []);
    if (annotation.error) return <ErrorMessage error={annotation.error} />;
    if (!annotation.data) return <p>Loading…</p>;
    const a = annotation.data;
    const sound = sounds.get(a.links.sound!);

    const remove = async () => {
        if (!confirm('Delete this annotation?')) return;
        await api(a.links.self!, { method: 'DELETE' });
        navigate(-1);
    };

    return (
        <>
            <h1>Annotation {a.id}</h1>
            <p className="lead">
                On <SoundLink href={a.links.sound!} id={a.sound_id} sound={sound} />
                {a.start_seconds !== null && ` · ${formatSeconds(a.start_seconds)} – ${formatSeconds(a.end_seconds)}`}
            </p>
            <dl className="props">
                <dt>sound</dt><dd><SoundLink href={a.links.sound!} id={a.sound_id} sound={sound} /> (id {a.sound_id})</dd>
                <dt>schema</dt><dd><ApiLink href={a.links.schema!}>{a.schema}</ApiLink> ({a.kind})</dd>
                <dt>segment</dt><dd>{a.start_seconds === null ? 'whole sound' : `${formatSeconds(a.start_seconds)} – ${formatSeconds(a.end_seconds)}`}</dd>
                <dt>value</dt><dd><AnnotationValue a={a} /></dd>
                <dt>data</dt><dd>{a.data === null || a.data === undefined ? <span className="muted">none</span> : <JsonView value={a.data} lines={16} />}</dd>
                <dt>created</dt><dd>{new Date(a.created_at).toLocaleString()} by <ApiLink href={a.links.created_by!}>user {a.created_by}</ApiLink></dd>
                {a.access !== undefined && <><dt>access</dt><dd><AccessBadge access={a.access} /></dd></>}
            </dl>
            {me.data?.id === a.created_by && <button className="danger" onClick={remove}>Delete</button>}
        </>
    );
};
