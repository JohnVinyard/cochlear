import { type App, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

export interface FirebaseIdentity {
    uid: string;
    email: string | null;
}

/**
 * Verifies firebase ID tokens.  When `FIREBASE_AUTH_EMULATOR_HOST` is set,
 * firebase-admin transparently verifies tokens issued by the local emulator.
 * Returns null for any invalid/expired token.
 */
export const createFirebaseVerifier = (projectId: string) => {
    let app: App | null = null;
    return async (idToken: string): Promise<FirebaseIdentity | null> => {
        app ??= initializeApp({ projectId }, 'cochlea');
        try {
            const decoded = await getAuth(app).verifyIdToken(idToken);
            return { uid: decoded.uid, email: decoded.email ?? null };
        } catch {
            return null;
        }
    };
};
