import type { AnnotationResource, LicenseType, SoundResource } from '@cochlea/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, type ApiError, appPath } from './api';
import { JsonView } from './elements/JsonView';
import { VectorBars } from './elements/VectorBars';
import { StarButton } from './favorites';

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

/**
 * Where a tag leads: annotations with exactly that tag. (The tags filter is
 * comma-separated, so a tag with a comma in it falls back to a phrase search.)
 */
export const tagSearchPath = (tag: string) =>
    tag.includes(',')
        ? `/annotations?${new URLSearchParams({ q: `"${tag.replace(/"/g, '')}"` })}`
        : `/annotations?${new URLSearchParams({ tags: tag })}`;

/** A tag pill that searches for its tag. It doesn't trigger a clickable row it's in (which plays the annotation). */
export const TagLink = ({ tag }: { tag: string }) => (
    <Link className="tag" to={tagSearchPath(tag)} title={`Annotations tagged "${tag}"`} onClick={(e) => e.stopPropagation()}>
        {tag}
    </Link>
);

/** An annotation's value; `compact` for table cells (JSON shows fewer lines, narrower) */
export const AnnotationValue = ({ a, compact = false }: { a: AnnotationResource; compact?: boolean }) => {
    if (a.tags) return <span>{a.tags.map((t) => <TagLink key={t} tag={t} />)}</span>;
    if (a.text) return <span>{a.text}</span>;
    if (a.kv) return compact ? <JsonView value={a.kv} lines={3} width="30rem" /> : <JsonView value={a.kv} lines={16} />;
    if (a.vector) {
        return compact ? (
            <span className="vector">
                <VectorBars values={a.vector} />
                <span className="muted">{a.vector.length}-d</span>
            </span>
        ) : (
            <div className="vector-detail">
                <VectorBars values={a.vector} width={Math.min(560, Math.max(240, a.vector.length * 12))} height={64} />
                <p className="muted">{a.vector.length} dimensions; hover a bar for its value. The values:</p>
                <JsonView value={a.vector} lines={4} />
            </div>
        );
    }
    if (a.blob) return <a href={a.blob.url}>{a.blob.content_type}</a>;
    return null;
};

/** Each license's short name, and the Creative Commons icons that spell it out */
const LICENSES: Record<LicenseType, { name: string; icons: string[] }> = {
    'https://creativecommons.org/licenses/by/4.0': { name: 'CC BY 4.0', icons: ['cc', 'by'] },
    'https://creativecommons.org/licenses/by-sa/4.0': { name: 'CC BY-SA 4.0', icons: ['cc', 'by', 'sa'] },
    'https://creativecommons.org/licenses/by-nd/4.0': { name: 'CC BY-ND 4.0', icons: ['cc', 'by', 'nd'] },
    'https://creativecommons.org/licenses/by-nc/4.0': { name: 'CC BY-NC 4.0', icons: ['cc', 'by', 'nc'] },
    'https://creativecommons.org/licenses/by-nc-sa/4.0': { name: 'CC BY-NC-SA 4.0', icons: ['cc', 'by', 'nc', 'sa'] },
    'https://creativecommons.org/licenses/by-nc-nd/4.0': { name: 'CC BY-NC-ND 4.0', icons: ['cc', 'by', 'nc', 'nd'] },
    'https://creativecommons.org/publicdomain/zero/1.0': { name: 'CC0 1.0', icons: ['cc', 'zero'] },
};

/**
 * A license, as Creative Commons' icons (public/icons/cc) linked to its
 * deed. With `compact`, just the icons (the name is the tooltip and the
 * accessible label); otherwise the name follows them.
 */
export const LicenseBadge = ({ license, compact = false }: { license: string; compact?: boolean }) => {
    const known = LICENSES[license as LicenseType];
    if (!known) return <a href={license}>license</a>;
    return (
        <a
            className="license"
            href={license}
            title={`${known.name}: the license this sound is available under`}
            aria-label={compact ? known.name : undefined}
            target="_blank"
            rel="noreferrer license"
        >
            {known.icons.map((icon) => (
                <img key={icon} src={`/icons/cc/${icon}.svg`} alt="" width={16} height={16} />
            ))}
            {!compact && <span>{known.name}</span>}
        </a>
    );
};

/** Sounds never change, so each is fetched once per page load, however many annotations refer to it */
const soundCache = new Map<string, Promise<SoundResource>>();

const loadSound = (href: string): Promise<SoundResource> => {
    let p = soundCache.get(href);
    if (!p) {
        p = api<SoundResource>(href);
        p.catch(() => soundCache.delete(href));
        soundCache.set(href, p);
    }
    return p;
};

/** The sounds behind these hrefs, by href, as they arrive */
export const useSounds = (hrefs: string[]): Map<string, SoundResource> => {
    const [sounds, setSounds] = useState(new Map<string, SoundResource>());
    const key = [...new Set(hrefs)].sort().join(' ');
    useEffect(() => {
        let cancelled = false;
        for (const href of key ? key.split(' ') : []) {
            loadSound(href)
                .then((s) => !cancelled && setSounds((prev) => (prev.has(href) ? prev : new Map(prev).set(href, s))))
                .catch(() => undefined); // a deleted sound: its link still works, with just an id
        }
        return () => {
            cancelled = true;
        };
    }, [key]);
    return sounds;
};

export const soundTitle = (s: Pick<SoundResource, 'id' | 'title'>) => s.title ?? `sound ${s.id}`;

/** A link to a sound, by its title once that's loaded */
export const SoundLink = ({ href, id, sound }: { href: string; id: number; sound?: SoundResource }) => (
    <ApiLink href={href}>{sound ? soundTitle(sound) : `sound ${id}`}</ApiLink>
);

export const AnnotationTable = ({
    items,
    onSelect,
    showSound = true,
}: {
    items: AnnotationResource[];
    onSelect?: (a: AnnotationResource) => void;
    /** Off where every annotation is on the same sound (e.g. that sound's page) */
    showSound?: boolean;
}) => {
    const sounds = useSounds(showSound ? items.map((a) => a.links.sound!) : []);
    return items.length ? (
        <table>
            <thead>
                <tr>
                    <th aria-label="star" />
                    <th>id</th>
                    {showSound && <th>sound</th>}
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
                        <td>
                            {a.start_seconds !== null && a.duration_seconds !== null && (
                                <StarButton
                                    soundId={a.sound_id}
                                    span={{ start_seconds: a.start_seconds, duration_seconds: a.duration_seconds }}
                                />
                            )}
                        </td>
                        <td><ApiLink href={a.links.self!}>{a.id}</ApiLink></td>
                        {showSound && (
                            <td
                                className="sound"
                                title={sounds.get(a.links.sound!)?.title ?? undefined}
                                onClick={(e) => e.stopPropagation()}
                            >
                                <SoundLink href={a.links.sound!} id={a.sound_id} sound={sounds.get(a.links.sound!)} />
                            </td>
                        )}
                        <td><ApiLink href={a.links.schema!}>{a.schema}</ApiLink></td>
                        <td>{formatSeconds(a.start_seconds)}</td>
                        <td>{formatSeconds(a.end_seconds)}</td>
                        <td onClick={(e) => a.kv && e.stopPropagation()}>
                            <AnnotationValue a={a} compact />
                        </td>
                        <td><ApiLink href={a.links.created_by!}>user {a.created_by}</ApiLink></td>
                        <td><AccessBadge access={a.access} /></td>
                    </tr>
                ))}
            </tbody>
        </table>
    ) : (
        <p className="muted">No annotations.</p>
    );
};
