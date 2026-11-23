/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    runner: 'groups',
    roots: ['<rootDir>/src', '<rootDir>/__tests__'],
    testMatch: ['**/*.test.ts'],
};
