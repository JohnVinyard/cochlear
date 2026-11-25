import {
    API_KEY_GRANTABLE_ROLES,
    type ApiKeyResource,
    type CreatedApiKeyResource,
    type Role,
    type UserResource,
} from '@cochlea/shared';
import { useState } from 'react';
import { useParams } from 'react-router';
import { api, follow, useResource } from '../api';
import { ApiLink, ErrorMessage } from '../components';

export const UserPage = () => {
    const { userId } = useParams();
    const user = useResource<UserResource>(`/users/${userId}`);
    if (user.error) return <ErrorMessage error={user.error} />;
    if (!user.data) return <p>Loading…</p>;
    const u = user.data;
    return (
        <>
            <h1>{u.user_name}</h1>
            {u.about_me && <p>{u.about_me}</p>}
            {u.info_url && <p><a href={u.info_url}>{u.info_url}</a></p>}
            <p className="row">
                <ApiLink href={u.links.sounds!.href}>Sounds</ApiLink>
                <ApiLink href={u.links.annotations!.href}>Annotations</ApiLink>
            </p>
        </>
    );
};

export const MePage = () => {
    const me = useResource<UserResource>('/users/me');
    const [error, setError] = useState<Error | null>(null);
    const [saved, setSaved] = useState(false);
    if (me.error) return <ErrorMessage error={me.error} />;
    if (!me.data) return <p>Loading…</p>;
    const u = me.data;

    const submit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setError(null);
        setSaved(false);
        const data = new FormData(e.currentTarget);
        try {
            await api('/users/me', {
                method: 'PATCH',
                body: {
                    user_name: data.get('user_name'),
                    about_me: data.get('about_me'),
                    info_url: String(data.get('info_url') ?? '') || null,
                },
            });
            setSaved(true);
            me.reload();
        } catch (err) {
            setError(err as Error);
        }
    };

    return (
        <>
            <h1>Your profile</h1>
            <p className="muted">
                user {u.id} · {u.email} · <ApiLink href={u.links.self!.href}>public profile</ApiLink>
            </p>
            <p>Roles: {u.roles?.map((r) => <span key={r} className="tag">{r}</span>)}</p>
            <form onSubmit={submit} className="stack narrow">
                <label>User name <input name="user_name" defaultValue={u.user_name} required pattern="[A-Za-z0-9_.\-]{1,64}" /></label>
                <label>About me <textarea name="about_me" defaultValue={u.about_me} /></label>
                <label>Info URL <input name="info_url" type="url" defaultValue={u.info_url ?? ''} /></label>
                <button type="submit">Save</button>
                {saved && <p className="muted">Saved.</p>}
                <ErrorMessage error={error} />
            </form>
        </>
    );
};

export const ApiKeysPage = () => {
    const me = useResource<UserResource>('/users/me');
    const keys = useResource<{ items: ApiKeyResource[] }>('/api-keys');
    const [created, setCreated] = useState<CreatedApiKeyResource | null>(null);
    const [roles, setRoles] = useState<Set<Role>>(new Set());
    const [error, setError] = useState<Error | null>(null);
    const grantable = API_KEY_GRANTABLE_ROLES.filter((r) => me.data?.roles?.includes(r));

    const toggle = (role: Role) =>
        setRoles((prev) => {
            const next = new Set(prev);
            if (next.has(role)) next.delete(role);
            else next.add(role);
            return next;
        });

    const create = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setError(null);
        const form = e.currentTarget;
        try {
            const key = await api<CreatedApiKeyResource>('/api-keys', {
                method: 'POST',
                body: { name: new FormData(form).get('name'), roles: [...roles] },
            });
            setCreated(key);
            form.reset();
            setRoles(new Set());
            keys.reload();
        } catch (err) {
            setError(err as Error);
        }
    };

    const revoke = async (key: ApiKeyResource) => {
        if (!confirm(`Revoke "${key.name}"?`)) return;
        await follow(key.links.delete!);
        keys.reload();
    };

    return (
        <>
            <h1>API keys</h1>
            <p className="muted">
                Keys can do anything you can, limited to the roles you give them. Send them as{' '}
                <code>Authorization: Bearer cka_…</code>.
            </p>
            {created && (
                <div className="panel secret">
                    <p>
                        New key <strong>{created.name}</strong>. Copy it now; it won't be shown again:
                    </p>
                    <code>{created.secret}</code>
                </div>
            )}
            <form onSubmit={create} className="stack panel">
                <label>Name <input name="name" required maxLength={255} /></label>
                <fieldset>
                    <legend>Roles</legend>
                    {grantable.map((r) => (
                        <label key={r} className="inline">
                            <input type="checkbox" checked={roles.has(r)} onChange={() => toggle(r)} /> {r}
                        </label>
                    ))}
                </fieldset>
                <button type="submit" disabled={!roles.size}>Create key</button>
                <ErrorMessage error={error} />
            </form>
            <ErrorMessage error={keys.error} />
            <table>
                <thead><tr><th>name</th><th>prefix</th><th>roles</th><th>created</th><th /></tr></thead>
                <tbody>
                    {keys.data?.items.map((k) => (
                        <tr key={k.id}>
                            <td>{k.name}</td>
                            <td><code>{k.prefix}…</code></td>
                            <td>{k.roles.map((r) => <span key={r} className="tag">{r}</span>)}</td>
                            <td>{new Date(k.created_at).toLocaleString()}</td>
                            <td><button className="link danger" onClick={() => revoke(k)}>revoke</button></td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </>
    );
};
