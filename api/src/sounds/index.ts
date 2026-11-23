import type pg from 'pg';
import { buildSoundsDomain, type SoundsDomain } from './domain';
import { buildSoundsPersistence } from './adapters/postgres';

export { router } from './adapters/express';
export type { SoundsDomain };

export const buildSounds = (pool: pg.Pool): SoundsDomain => buildSoundsDomain(buildSoundsPersistence(pool));
