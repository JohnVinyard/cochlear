import { initializeApp } from 'firebase/app';
import {
    connectAuthEmulator,
    createUserWithEmailAndPassword,
    getAuth,
    onIdTokenChanged,
    signInWithEmailAndPassword,
    signOut,
    type User,
} from 'firebase/auth';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { config } from './config';

const app = initializeApp({
    apiKey: config.firebaseApiKey,
    projectId: config.firebaseProjectId,
    authDomain: `${config.firebaseProjectId}.firebaseapp.com`,
});
export const auth = getAuth(app);
if (config.firebaseAuthEmulatorUrl) {
    connectAuthEmulator(auth, config.firebaseAuthEmulatorUrl, { disableWarnings: true });
}

interface AuthState {
    user: User | null;
    loading: boolean;
}

const AuthContext = createContext<AuthState>({ user: null, loading: true });

export const AuthProvider = ({ children }: { children: ReactNode }) => {
    const [state, setState] = useState<AuthState>({ user: null, loading: true });
    useEffect(() => onIdTokenChanged(auth, (user) => setState({ user, loading: false })), []);
    return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
};

export const useAuth = () => useContext(AuthContext);

export const signIn = async (email: string, password: string, create: boolean) => {
    if (create) await createUserWithEmailAndPassword(auth, email, password);
    else await signInWithEmailAndPassword(auth, email, password);
};

export const logOut = () => signOut(auth);
