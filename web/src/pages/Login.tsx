import { useState } from 'react';
import { signIn } from '../auth';
import { config } from '../config';

export const LoginPage = () => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('password');
    const [error, setError] = useState<string | null>(null);

    const submit = (create: boolean) => async (e: React.SyntheticEvent) => {
        e.preventDefault();
        setError(null);
        try {
            await signIn(email, password, create);
        } catch (err) {
            setError((err as Error).message);
        }
    };

    return (
        <main className="page narrow">
            <h1>cochlea</h1>
            <p className="muted">Describe audio on the internet.</p>
            <form onSubmit={submit(false)} className="stack">
                <label>Email <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
                <label>Password <input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
                <div className="row">
                    <button type="submit">Sign in</button>
                    <button type="button" className="secondary" onClick={submit(true)}>Create account</button>
                </div>
                {error && <p className="error">{error}</p>}
                {config.firebaseAuthEmulatorUrl && (
                    <p className="muted">Using the firebase auth emulator at {config.firebaseAuthEmulatorUrl}; any email works.</p>
                )}
            </form>
        </main>
    );
};
