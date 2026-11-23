/**
 * Administrative commands for local development and operations.
 *
 *   yarn cli grant-role <email> <ROLE>
 *   yarn cli revoke-role <email> <ROLE>
 *   yarn cli dev-token <email>          (firebase emulator only)
 *
 * Inside docker compose:  docker compose exec api yarn cli ...
 */
import { isRole, ROLES } from '@cochlea/shared';
import { emulatorSignIn } from './devtools/firebaseEmulator';
import { createPool } from './shared/db/pool';
import { buildUsers } from './users';

const usage = () => {
    console.error(
        [
            'usage:',
            '  yarn cli grant-role <email> <ROLE>',
            '  yarn cli revoke-role <email> <ROLE>',
            '  yarn cli dev-token <email>',
            '',
            `roles: ${ROLES.join(', ')}`,
        ].join('\n')
    );
    process.exit(2);
};

const main = async () => {
    const [command, email, role] = process.argv.slice(2);
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
