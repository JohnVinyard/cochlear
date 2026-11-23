import type pg from 'pg';
import { buildUsersDomain, type UsersDomain } from './domain';
import { buildUsersPersistence } from './adapters/postgres';

export { router } from './adapters/express';
export type { UsersDomain };

export const buildUsers = (pool: pg.Pool): UsersDomain => buildUsersDomain(buildUsersPersistence(pool));
