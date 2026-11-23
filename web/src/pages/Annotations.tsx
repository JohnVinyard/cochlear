import type { AnnotationResource, UserResource } from '@cochlea/shared';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { api, useFeed, useResource } from '../api';
import { AccessBadge, AnnotationTable, AnnotationValue, ApiLink, ErrorMessage, formatSeconds, LoadMore } from '../components';

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
        for (const key of ['schema', 'tags']) {
            const v = String(data.get(key) ?? '').trim();
            if (v) next.set(key, v);
        }
        setSearch(next);
    };

    return (
        <>
            <h1>{soundId ? `Annotations of sound ${soundId}` : userId ? `Annotations by user ${userId}` : 'Annotations'}</h1>
            <form className="row panel" onSubmit={filter}>
                <input name="schema" placeholder="schema, e.g. tags@1" defaultValue={search.get('schema') ?? ''} />
                <input name="tags" placeholder="tags (all of), comma separated" defaultValue={search.get('tags') ?? ''} />
                <button type="submit">Filter</button>
            </form>
            <ErrorMessage error={feed.error} />
            <AnnotationTable items={feed.items} />
            <LoadMore hasMore={feed.hasMore} loadMore={feed.loadMore} />
        </>
    );
};

export const AnnotationPage = () => {
    const { annotationId } = useParams();
    const navigate = useNavigate();
    const annotation = useResource<AnnotationResource>(`/annotations/${annotationId}`);
    const me = useResource<UserResource>('/users/me');
    if (annotation.error) return <ErrorMessage error={annotation.error} />;
    if (!annotation.data) return <p>Loading…</p>;
    const a = annotation.data;

    const remove = async () => {
        if (!confirm('Delete this annotation?')) return;
        await api(a.links.self!, { method: 'DELETE' });
        navigate(-1);
    };

    return (
        <>
            <h1>Annotation {a.id}</h1>
            <dl className="props">
                <dt>sound</dt><dd><ApiLink href={a.links.sound!}>sound {a.sound_id}</ApiLink></dd>
                <dt>schema</dt><dd><ApiLink href={a.links.schema!}>{a.schema}</ApiLink> ({a.kind})</dd>
                <dt>segment</dt><dd>{a.start_seconds === null ? 'whole sound' : `${formatSeconds(a.start_seconds)} – ${formatSeconds(a.end_seconds)}`}</dd>
                <dt>value</dt><dd><AnnotationValue a={a} /></dd>
                <dt>data</dt><dd><code>{JSON.stringify(a.data)}</code></dd>
                <dt>created</dt><dd>{new Date(a.created_at).toLocaleString()} by <ApiLink href={a.links.created_by!}>user {a.created_by}</ApiLink></dd>
                {a.access !== undefined && <><dt>access</dt><dd><AccessBadge access={a.access} /></dd></>}
            </dl>
            {me.data?.id === a.created_by && <button className="danger" onClick={remove}>Delete</button>}
        </>
    );
};
