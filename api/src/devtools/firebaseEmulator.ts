/**
 * Helpers for obtaining real ID tokens from the firebase auth emulator, used
 * by the `dev-token` CLI command and the API test suite.  Never used by the
 * server itself.
 */

export const DEV_PASSWORD = 'password';

export interface EmulatorSession {
    uid: string;
    email: string;
    idToken: string;
}

const emulatorUrl = (host: string, path: string) =>
    `http://${host}/identitytoolkit.googleapis.com/v1/${path}?key=fake-api-key`;

const post = async (host: string, path: string, body: object) => {
    const res = await fetch(emulatorUrl(host, path), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { ok: res.ok, body: (await res.json()) as Record<string, any> };
};

/** Signs in as `email`, creating the emulator account if necessary */
export const emulatorSignIn = async (
    email: string,
    host = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? 'localhost:9099'
): Promise<EmulatorSession> => {
    const credentials = { email, password: DEV_PASSWORD, returnSecureToken: true };
    let result = await post(host, 'accounts:signInWithPassword', credentials);
    if (!result.ok) {
        result = await post(host, 'accounts:signUp', credentials);
    }
    if (!result.ok) {
        throw new Error(`firebase emulator sign-in failed: ${JSON.stringify(result.body)}`);
    }
    return { uid: result.body.localId, email, idToken: result.body.idToken };
};

/**
 * Deletes these accounts from the emulator (and only these), e.g. the ones
 * the API test suite created. Uses the emulator's admin access ("Bearer
 * owner"), so it works only against the emulator.
 */
export const deleteEmulatorAccounts = async (
    uids: string[],
    projectId: string,
    host = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? 'localhost:9099'
): Promise<number> => {
    let deleted = 0;
    for (let i = 0; i < uids.length; i += 1000) {
        const localIds = uids.slice(i, i + 1000);
        const res = await fetch(
            `http://${host}/identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:batchDelete`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
                body: JSON.stringify({ localIds, force: true }),
            }
        );
        if (!res.ok) throw new Error(`deleting emulator accounts failed: HTTP ${res.status} ${await res.text()}`);
        deleted += localIds.length;
    }
    return deleted;
};
