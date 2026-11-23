/**
 * Clean ("onion") architecture rules.  Each feature directory under src/ is
 * structured as:
 *
 *   <feature>/domain.ts            types, errors, incoming/outgoing ports, use cases
 *   <feature>/adapters/<x>.ts      postgres, express, gcs, firebase, ...
 *   <feature>/index.ts             composition root for the feature
 *
 * plus src/shared/ (cross-cutting, framework-free building blocks, and
 * src/shared/{http,db} adapter helpers), and src/app.ts, the top-level
 * composition root.
 */

const feature = '^src/([^/]+)';
const testFile = '[.]test[.]ts$';

/** Things a domain module may depend on */
const domainAllowed = [
    '^src/[^/]+/domain[.]ts$',
    '^src/shared/(errors|ids|paging)[.]ts$',
    '^(node_modules/@cochlea/shared|[.][.]/shared)/',
    '^(node:)?crypto$',
];

module.exports = {
    forbidden: [
        {
            name: 'clean-domain',
            severity: 'error',
            comment:
                'Domain code may depend only on other domain modules and framework-free shared modules ' +
                '(errors, ids, paging, @cochlea/shared).  No express, pg, firebase, ajv, adapters, etc.',
            from: { path: `${feature}/domain[.]ts$` },
            to: { pathNot: domainAllowed },
        },
        {
            name: 'clean-adapters',
            severity: 'error',
            comment: 'An adapter module may not depend on another adapter module.',
            from: { path: `${feature}/adapters/([^/]+)[.]ts$`, pathNot: testFile },
            to: { path: '^src/[^/]+/adapters/', pathNot: ['^src/$1/adapters/$2[.]ts$', '^src/auth/adapters/express[.]ts$', '[.]json$'] },
        },
        {
            name: 'only-express-adapters-use-http',
            severity: 'error',
            comment:
                'Only express adapters (and the composition root) may depend on HTTP helpers or the ' +
                'authentication middleware; other adapters throw domain errors.',
            from: {
                path: '^src/',
                pathNot: [
                    'adapters/express[.]ts$',
                    '^src/shared/http/',
                    '^src/app[.]ts$',
                    '^src/[^/]+/index[.]ts$',
                    '^src/openapi/',
                    testFile,
                ],
            },
            to: { path: ['^src/shared/http/', '^src/auth/adapters/express[.]ts$'] },
        },
        {
            name: 'no-reaching-into-other-features',
            severity: 'error',
            comment:
                "A feature may only use another feature's domain (types/ports) or index (composition); " +
                'never its adapters.',
            from: { path: `${feature}/`, pathNot: ['^src/(shared|openapi)/', testFile] },
            to: {
                path: '^src/([^/]+)/adapters/',
                pathNot: ['^src/$1/', '^src/auth/adapters/express[.]ts$'],
            },
        },
        {
            name: 'no-circular',
            severity: 'error',
            from: {},
            to: { circular: true },
        },
        {
            name: 'no-orphans',
            severity: 'warn',
            from: { orphan: true, pathNot: ['[.]d[.]ts$', testFile, '^src/(cli|index)[.]ts$'] },
            to: {},
        },
        {
            name: 'not-to-test',
            severity: 'error',
            from: { pathNot: testFile },
            to: { path: testFile },
        },
        {
            name: 'not-to-dev-dep',
            severity: 'error',
            comment: 'Production code may not depend on devDependencies.',
            from: { path: '^src/', pathNot: [testFile, '^src/devtools/'] },
            to: { dependencyTypes: ['npm-dev'] },
        },
    ],
    options: {
        doNotFollow: { path: 'node_modules' },
        tsPreCompilationDeps: true,
        tsConfig: { fileName: 'tsconfig.json' },
        combinedDependencies: true,
        exclude: { path: '^build/' },
    },
};
