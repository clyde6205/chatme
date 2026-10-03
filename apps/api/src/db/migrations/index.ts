import type { Migration, MigrationProvider } from 'kysely';
import * as m0001 from './0001_foundation.js';

/**
 * Migrations are registered statically so they survive bundling. Names sort
 * lexically; never rename or edit a migration that has shipped.
 */
const migrations: Record<string, Migration> = {
  '0001_foundation': m0001,
};

export const migrationProvider: MigrationProvider = {
  getMigrations: async () => migrations,
};
