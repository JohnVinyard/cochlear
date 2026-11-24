/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    runner: 'groups',
    roots: ['<rootDir>/src', '<rootDir>/__tests__'],
    testMatch: ['**/*.test.ts'],
    // the API group gets its own database and API server (__tests__/api/environment.ts)
    globalSetup: '<rootDir>/__tests__/api/globalSetup.ts',
    globalTeardown: '<rootDir>/__tests__/api/globalTeardown.ts',
};
