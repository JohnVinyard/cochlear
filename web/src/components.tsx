import type { AnnotationResource } from '@cochlea/shared';
import { Link } from 'react-router';
import { type ApiError, appPath } from './api';

export const ErrorMessage = ({ error }: { error: ApiError | Error | null }) =>
    error ? <p className="error">{'errors' in error ? (error as ApiError).errors.join('; ') || error.message : error.message}</p> : null;

/** Renders an API href as an in-app link */
export const ApiLink = ({ href, children }: { href: string; children: React.ReactNode }) => (
    <Link to={appPath(href)}>{children}</Link>
);

export const LoadMore = ({ hasMore, loadMore }: { hasMore: boolean; loadMore: () => void }) =>
    hasMore ? (
        <button className="secondary" onClick={loadMore}>
            Load more
        </button>
    ) : null;

export const formatSeconds = (s: number | null) => (s === null ? '—' : `${s.toFixed(2)}s`);

export const AccessBadge = ({ access }: { access: AnnotationResource['access'] }) => {
    if (access === undefined) return null;
    const label = access === null ? 'private' : access === '*' ? 'public' : `shared with ${access.join(', ')}`;
    return <span className="badge">{label}</span>;
};

export const AnnotationValue = ({ a }: { a: AnnotationResource }) => {
    if (a.tags) return <span>{a.tags.map((t) => <span key={t} className="tag">{t}</span>)}</span>;
    if (a.text) return <span>{a.text}</span>;
    if (a.kv) return <code>{JSON.stringify(a.kv)}</code>;
    if (a.vector) return <code title={a.vector.join(', ')}>[{a.vector.slice(0, 6).map((v) => v.toFixed(3)).join(', ')}{a.vector.length > 6 ? ', …' : ''}] ({a.vector.length})</code>;
    if (a.blob) return <a href={a.blob.url}>{a.blob.content_type}</a>;
    return null;
};

export const AnnotationTable = ({ items, onSelect }: { items: AnnotationResource[]; onSelect?: (a: AnnotationResource) => void }) =>
    items.length ? (
        <table>
            <thead>
                <tr>
                    <th>id</th>
                    <th>schema</th>
                    <th>start</th>
                    <th>end</th>
                    <th>value</th>
                    <th>by</th>
                    <th />
                </tr>
            </thead>
            <tbody>
                {items.map((a) => (
                    <tr key={a.id} onClick={() => onSelect?.(a)} className={onSelect && a.start_seconds !== null ? 'clickable' : ''}>
                        <td><ApiLink href={a.links.self!}>{a.id}</ApiLink></td>
                        <td><ApiLink href={a.links.schema!}>{a.schema}</ApiLink></td>
                        <td>{formatSeconds(a.start_seconds)}</td>
                        <td>{formatSeconds(a.end_seconds)}</td>
                        <td><AnnotationValue a={a} /></td>
                        <td><ApiLink href={a.links.created_by!}>user {a.created_by}</ApiLink></td>
                        <td><AccessBadge access={a.access} /></td>
                    </tr>
                ))}
            </tbody>
        </table>
    ) : (
        <p className="muted">No annotations.</p>
    );
