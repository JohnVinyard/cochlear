import { ANNOTATION_KINDS, type AnnotationSchemaResource, type UserResource } from '@cochlea/shared';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api, appPath, useFeed, useResource } from '../api';
import { ApiLink, ErrorMessage, LoadMore } from '../components';

export const SchemasPage = () => {
    const feed = useFeed<AnnotationSchemaResource>('/annotation-schemas');
    const me = useResource<UserResource>('/users/me');
    return (
        <>
            <h1>Annotation schemas</h1>
            {me.data?.roles?.includes('ANNOTATION_SCHEMA_CREATOR') && <CreateSchema />}
            <ErrorMessage error={feed.error} />
            <table>
                <thead><tr><th>schema</th><th>kind</th><th>description</th><th>by</th></tr></thead>
                <tbody>
                    {feed.items.map((s) => (
                        <tr key={s.id}>
                            <td><ApiLink href={s.links.self!}>{s.ref}</ApiLink></td>
                            <td>{s.kind}{s.vector_dim ? `(${s.vector_dim})` : ''}</td>
                            <td>{s.description}</td>
                            <td><ApiLink href={s.links.created_by!}>user {s.created_by}</ApiLink></td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <LoadMore hasMore={feed.hasMore} loadMore={feed.loadMore} />
        </>
    );
};

const CreateSchema = () => {
    const navigate = useNavigate();
    const [error, setError] = useState<Error | null>(null);
    const [kind, setKind] = useState<string>('tags');

    const submit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setError(null);
        const data = new FormData(e.currentTarget);
        try {
            const jsonSchema = String(data.get('json_schema') ?? '').trim();
            const schema = await api<AnnotationSchemaResource>('/annotation-schemas', {
                method: 'POST',
                body: {
                    name: data.get('name'),
                    kind,
                    description: data.get('description'),
                    vector_dim: kind === 'vector' ? Number(data.get('vector_dim')) : null,
                    json_schema: jsonSchema ? JSON.parse(jsonSchema) : null,
                },
            });
            navigate(appPath(schema.links.self!));
        } catch (err) {
            setError(err as Error);
        }
    };

    return (
        <details className="panel">
            <summary>Publish a schema (or the next version of one of yours)</summary>
            <form onSubmit={submit} className="stack">
                <label>Name <input name="name" required pattern="[a-z0-9][a-z0-9\-]{0,63}" /></label>
                <label>Kind
                    <select value={kind} onChange={(e) => setKind(e.target.value)}>
                        {ANNOTATION_KINDS.map((k) => <option key={k}>{k}</option>)}
                    </select>
                </label>
                {kind === 'vector' && <label>Vector dimension <input name="vector_dim" type="number" min="1" max="2000" required /></label>}
                <label>Description <textarea name="description" /></label>
                <label>JSON schema for <code>data</code> (optional) <textarea name="json_schema" placeholder='{"type": "object"}' /></label>
                <button type="submit">Publish</button>
                <ErrorMessage error={error} />
            </form>
        </details>
    );
};

export const SchemaPage = () => {
    const { ref } = useParams();
    const schema = useResource<AnnotationSchemaResource>(`/annotation-schemas/${ref}`);
    if (schema.error) return <ErrorMessage error={schema.error} />;
    if (!schema.data) return <p>Loading…</p>;
    const s = schema.data;
    return (
        <>
            <h1>{s.ref}</h1>
            <p>{s.description}</p>
            <dl className="props">
                <dt>kind</dt><dd>{s.kind}{s.vector_dim ? ` (dimension ${s.vector_dim})` : ''}</dd>
                <dt>created</dt><dd>{new Date(s.created_at).toLocaleString()} by <ApiLink href={s.links.created_by!}>user {s.created_by}</ApiLink></dd>
                <dt>data schema</dt><dd>{s.json_schema ? <pre>{JSON.stringify(s.json_schema, null, 2)}</pre> : 'none (free-form)'}</dd>
            </dl>
            <ApiLink href={s.links.annotations!}>Annotations using this schema</ApiLink>
        </>
    );
};
