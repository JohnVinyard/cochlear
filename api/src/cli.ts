/**
 * Administrative commands for local development and operations.
 *
 *   yarn cli grant-role <email> <ROLE>
 *   yarn cli revoke-role <email> <ROLE>
 *   yarn cli dev-token <email>          (firebase emulator only)
 *   yarn cli clear-data [--keep-ids]    (local databases only)
 *   yarn cli remove-test-data [--yes]   (local databases only)
 *   yarn cli create-bot <user_name> [--about TEXT] [--info-url URL]
 *
 * Inside docker compose:  docker compose exec api yarn cli ...
 */
import { parseArgs } from 'node:util';
import { isRole, type Role, ROLES } from '@cochlea/shared';
import { buildApiKeys } from './apiKeys';
import { assertLocalDatabase, clearSoundsAndAnnotations } from './devtools/clearData';
import { deleteEmulatorAccounts, emulatorSignIn } from './devtools/firebaseEmulator';
import { countTestData, dropIndexes, removeTestData } from './devtools/removeTestData';
import { createPool, dbConfigFromEnv } from './shared/db/pool';
import { buildUsers } from './users';

/** Bots ingest data: they can read everything and create sounds, schemas and annotations */
const BOT_ROLES: Role[] = [
    'SOUND_READER',
    'ANNOTATION_READER',
    'ANNOTATION_SCHEMA_READER',
    'SOUND_EDITOR',
    'ANNOTATION_EDITOR',
    'ANNOTATION_SCHEMA_CREATOR',
];

const usage = (): never => {
    console.error(
        [
            'usage:',
            '  yarn cli grant-role <email> <ROLE>',
            '  yarn cli revoke-role <email> <ROLE>',
            '  yarn cli dev-token <email>',
            '  yarn cli clear-data [--keep-ids]   delete all sounds and annotations, and reset user state (local databases only)',
            '  yarn cli remove-test-data [--yes]  delete test data: @example.com users and what they own, and sounds on',
            '                                     example.com (local databases only; without --yes, only reports)',
            '  yarn cli create-bot <user_name> [--about TEXT] [--info-url URL]',
            '                                     create or update a bot user and print a new API key for it',
            '',
            `roles: ${ROLES.join(', ')}`,
        ].join('\n')
    );
    process.exit(2);
};

const main = async () => {
    const [command, email, role] = process.argv.slice(2);

    if (command === 'remove-test-data') {
        const flags = process.argv.slice(3);
        if (flags.some((f) => f !== '--yes')) usage();
        const db = dbConfigFromEnv();
        assertLocalDatabase(db.host);
        const pool = createPool(db);
        try {
            const describe = (c: Awaited<ReturnType<typeof countTestData>>) =>
                `${c.users} users, ${c.sounds} sounds, ${c.schemas} schemas (${c.vectorIndexes} with vector indices), ` +
                `${c.annotations} annotations (${c.realUsersAnnotations} of them by other users, on test sounds)`;
            if (!flags.includes('--yes')) {
                console.log(`would remove ${describe(await countTestData(pool))}; run with --yes to remove them`);
                return;
            }
            const removed = await removeTestData(pool);
            console.log(`removed ${describe(removed)}`);
            await dropIndexes(pool, removed.vectorIndexNames);
            console.log(`dropped ${removed.vectorIndexNames.length} vector indices`);
            if (removed.firebaseUids.length && process.env.FIREBASE_AUTH_EMULATOR_HOST) {
                const n = await deleteEmulatorAccounts(removed.firebaseUids, process.env.FIREBASE_PROJECT_ID ?? 'demo-cochlea');
                console.log(`deleted ${n} firebase emulator accounts`);
            }
        } finally {
            await pool.end();
        }
        return;
    }

    if (command === 'clear-data') {
        const flags = process.argv.slice(3);
        const unknown = flags.filter((f) => f !== '--keep-ids');
        if (unknown.length) usage();
        const db = dbConfigFromEnv();
        assertLocalDatabase(db.host);
        const pool = createPool(db);
        try {
            const keepIds = flags.includes('--keep-ids');
            const { sounds, annotations, states } = await clearSoundsAndAnnotations(pool, { keepIds });
            console.log(
                `deleted ${sounds} sounds and ${annotations} annotations, and reset ${states} users' state` +
                    (keepIds ? ' (ids continue from where they were)' : ' (ids restart at 1)')
            );
        } finally {
            await pool.end();
        }
        return;
    }

    if (command === 'create-bot') {
        let parsed;
        try {
            parsed = parseArgs({
                args: process.argv.slice(3),
                allowPositionals: true,
                options: { about: { type: 'string' }, 'info-url': { type: 'string' } },
            });
        } catch {
            return usage();
        }
        const [userName, ...rest] = parsed.positionals;
        if (!userName || rest.length) usage();
        const pool = createPool();
        try {
            const bot = await buildUsers(pool).ensureBotUser({
                userName: userName!,
                aboutMe: parsed.values.about,
                infoUrl: parsed.values['info-url'],
                roles: BOT_ROLES,
            });
            const key = await buildApiKeys(pool).issueApiKey(bot, {
                name: `${userName} (cli, ${new Date().toISOString().slice(0, 10)})`,
                roles: BOT_ROLES,
            });
            // the secret alone goes to stdout, so `KEY=$(yarn -s cli create-bot ...)` works
            console.error(`bot ${bot.userName} (id ${bot.id}): ${bot.roles.join(', ')}`);
            console.error(`new API key ${key.prefix}... (id ${key.id}); it won't be shown again`);
            console.log(key.secret);
        } finally {
            await pool.end();
        }
        return;
    }

    if (!command || !email) usage();

    if (command === 'dev-token') {
        if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
            throw new Error('dev-token only works against the firebase auth emulator');
        }
        const session = await emulatorSignIn(email!);
        // the user row is provisioned on the first API request made with this token
        console.log(session.idToken);
        return;
    }

    if (command === 'grant-role' || command === 'revoke-role') {
        if (!isRole(role)) usage();
        const pool = createPool();
        try {
            const users = buildUsers(pool);
            const user =
                command === 'grant-role'
                    ? await users.grantRole(email!, role as never)
                    : await users.revokeRole(email!, role as never);
            console.log(`${user.userName} <${user.email}> (id ${user.id}): ${user.roles.join(', ')}`);
        } finally {
            await pool.end();
        }
        return;
    }

    usage();
};

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
