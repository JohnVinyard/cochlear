import { DEFAULT_USER_ROLES, type Role } from '@cochlea/shared';
import type { Principal } from '../auth/domain';
import { InvalidRequest, NotFound, PreconditionFailed, Unauthenticated } from '../shared/errors';
import type { UserId } from '../shared/ids';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface User {
    id: UserId;
    firebaseUid: string | null;
    userName: string;
    email: string | null;
    aboutMe: string;
    infoUrl: string | null;
    createdAt: Date;
    roles: Role[];
}

export interface NewUser {
    /** null for users that never sign in interactively (bots, the system user) */
    firebaseUid: string | null;
    userName: string;
    email: string | null;
    roles: readonly Role[];
}

export interface UserUpdate {
    userName?: string;
    aboutMe?: string;
    infoUrl?: string | null;
}

/**
 * A small, private, machine-readable JSON document per user, e.g. a bot's
 * feed cursor. `version` increases on every write (and when data is cleared),
 * and backs ETag / If-Match.
 */
export interface UserState {
    document: Record<string, unknown>;
    version: number;
    updatedAt: Date | null;
}

/** Serialized, in UTF-8 bytes */
export const MAX_STATE_BYTES = 64 * 1024;

export class UserNameTaken extends InvalidRequest {
    constructor(userName: string) {
        super([`user_name "${userName}" is already taken`]);
    }
}

/** A user that only ever authenticates with API keys, e.g. a dataset integration */
export interface BotUserModel {
    userName: string;
    aboutMe?: string;
    infoUrl?: string | null;
    roles: readonly Role[];
}

export const USER_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

// ---------------------------------------------------------------------------
// Outgoing ports
// ---------------------------------------------------------------------------

export interface UsersPersistence {
    getById(id: UserId): Promise<User | null>;
    getByFirebaseUid(uid: string): Promise<User | null>;
    getByEmail(email: string): Promise<User | null>;
    getByUserName(userName: string): Promise<User | null>;
    /** Throws `UserNameTaken` if the name is in use */
    insert(user: NewUser): Promise<User>;
    /** Throws `UserNameTaken` if the name is in use */
    update(id: UserId, update: UserUpdate): Promise<void>;
    /** Returns the subset of `ids` that belong to live users */
    existingIds(ids: readonly UserId[]): Promise<Set<UserId>>;
    grantRole(id: UserId, role: Role): Promise<void>;
    revokeRole(id: UserId, role: Role): Promise<void>;
    getState(id: UserId): Promise<UserState>;
    /** Replaces the state; returns null (and writes nothing) if `ifVersion` is given and isn't current */
    putState(id: UserId, document: Record<string, unknown>, ifVersion: number | null): Promise<UserState | null>;
}

export interface FirebaseIdentity {
    uid: string;
    email: string | null;
}

// ---------------------------------------------------------------------------
// Incoming ports
// ---------------------------------------------------------------------------

export interface UsersDomain {
    /** Resolves (auto-provisioning if necessary) the user for a verified firebase identity */
    principalForFirebaseIdentity(identity: FirebaseIdentity): Promise<Principal>;
    getMe(principal: Principal): Promise<User>;
    getUser(principal: Principal, id: UserId): Promise<User>;
    updateMe(principal: Principal, update: UserUpdate): Promise<User>;
    getMyState(principal: Principal): Promise<UserState>;
    /**
     * Replaces the caller's state document. With `ifVersion`, only if that's
     * still the current version (otherwise `PreconditionFailed`).
     */
    putMyState(principal: Principal, document: unknown, ifVersion?: number): Promise<UserState>;
    /** Throws `InvalidRequest` listing any ids that are not live users */
    requireUsersExist(ids: readonly UserId[]): Promise<void>;
    /** Administrative (CLI-only) operations */
    grantRole(email: string, role: Role): Promise<User>;
    revokeRole(email: string, role: Role): Promise<User>;
    /**
     * Creates a bot user, or brings an existing one up to date (adding any
     * missing roles; existing roles are never removed). Refuses to touch a
     * user that signs in with firebase.
     */
    ensureBotUser(model: BotUserModel): Promise<User>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export const userNameFromEmail = (email: string | null): string => {
    const local = (email ?? '').split('@')[0] ?? '';
    const cleaned = local.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 48);
    return cleaned || 'user';
};

const randomSuffix = (random: () => number) =>
    Math.floor(random() * 0xffffff)
        .toString(16)
        .padStart(6, '0');

export const toPrincipal = (user: User): Principal => ({
    kind: 'firebase',
    user: { id: user.id, userName: user.userName },
    roles: new Set(user.roles),
});

export const buildUsersDomain = (
    persistence: UsersPersistence,
    random: () => number = Math.random
): UsersDomain => {
    const mustGet = async (id: UserId): Promise<User> => {
        const user = await persistence.getById(id);
        if (!user) throw new NotFound(`user ${id}`);
        return user;
    };

    const mustGetByEmail = async (email: string): Promise<User> => {
        const user = await persistence.getByEmail(email);
        if (!user) throw new NotFound(`user with email ${email}`);
        return user;
    };

    const provision = async (identity: FirebaseIdentity): Promise<User> => {
        const base = userNameFromEmail(identity.email);
        for (let attempt = 0; attempt < 5; attempt++) {
            const userName = attempt === 0 ? base : `${base}-${randomSuffix(random)}`;
            try {
                return await persistence.insert({
                    firebaseUid: identity.uid,
                    userName,
                    email: identity.email,
                    roles: DEFAULT_USER_ROLES,
                });
            } catch (err) {
                if (!(err instanceof UserNameTaken)) throw err;
                // a concurrent first request may have provisioned this uid
                const existing = await persistence.getByFirebaseUid(identity.uid);
                if (existing) return existing;
            }
        }
        throw new Error(`Could not allocate a user name for ${identity.uid}`);
    };

    return {
        async principalForFirebaseIdentity(identity) {
            const user = (await persistence.getByFirebaseUid(identity.uid)) ?? (await provision(identity));
            return toPrincipal(user);
        },

        async getMe(principal) {
            const user = await persistence.getById(principal.user.id);
            if (!user) throw new Unauthenticated();
            return user;
        },

        async getUser(_principal, id) {
            return mustGet(id);
        },

        async updateMe(principal, update) {
            if (update.userName !== undefined && !USER_NAME_PATTERN.test(update.userName)) {
                throw new InvalidRequest([
                    'user_name must be 1-64 characters of letters, digits, "_", "." or "-"',
                ]);
            }
            await persistence.update(principal.user.id, update);
            return mustGet(principal.user.id);
        },

        async getMyState(principal) {
            return persistence.getState(principal.user.id);
        },

        async putMyState(principal, document, ifVersion) {
            if (document === null || typeof document !== 'object' || Array.isArray(document)) {
                throw new InvalidRequest(['state must be a JSON object']);
            }
            const bytes = Buffer.byteLength(JSON.stringify(document), 'utf8');
            if (bytes > MAX_STATE_BYTES) {
                throw new InvalidRequest([`state is ${bytes} bytes; the limit is ${MAX_STATE_BYTES}`]);
            }
            const state = await persistence.putState(
                principal.user.id,
                document as Record<string, unknown>,
                ifVersion ?? null
            );
            if (!state) {
                throw new PreconditionFailed(`state has changed since version ${ifVersion}; fetch it and try again`);
            }
            return state;
        },

        async requireUsersExist(ids) {
            const unique = [...new Set(ids)];
            const existing = await persistence.existingIds(unique);
            const missing = unique.filter((id) => !existing.has(id));
            if (missing.length) {
                throw new InvalidRequest([`unknown user id(s): ${missing.join(', ')}`]);
            }
        },

        async grantRole(email, role) {
            const user = await mustGetByEmail(email);
            await persistence.grantRole(user.id, role);
            return mustGet(user.id);
        },

        async revokeRole(email, role) {
            const user = await mustGetByEmail(email);
            await persistence.revokeRole(user.id, role);
            return mustGet(user.id);
        },

        async ensureBotUser(model) {
            if (!USER_NAME_PATTERN.test(model.userName)) {
                throw new InvalidRequest([
                    'user_name must be 1-64 characters of letters, digits, "_", "." or "-"',
                ]);
            }
            const existing = await persistence.getByUserName(model.userName);
            if (existing?.firebaseUid) {
                throw new InvalidRequest([`${model.userName} signs in with firebase; it isn't a bot`]);
            }
            const user =
                existing ??
                (await persistence.insert({
                    firebaseUid: null,
                    userName: model.userName,
                    email: null,
                    roles: model.roles,
                }));
            for (const role of model.roles.filter((r) => !user.roles.includes(r))) {
                await persistence.grantRole(user.id, role);
            }
            const update: UserUpdate = {};
            if (model.aboutMe !== undefined) update.aboutMe = model.aboutMe;
            if (model.infoUrl !== undefined) update.infoUrl = model.infoUrl;
            await persistence.update(user.id, update);
            return mustGet(user.id);
        },
    };
};
