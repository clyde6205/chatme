import type { Migration, MigrationProvider } from 'kysely';
import * as m0001 from './0001_foundation.js';
import * as m0002 from './0002_email_recovery.js';
import * as m0003 from './0003_realtime.js';
import * as m0004 from './0004_ai_gateway.js';

/**
 * Migrations are registered statically so they survive bundling. Names sort
 * lexically; never rename or edit a migration that has shipped.
 */
const migrations: Record<string, Migration> = {
  '0001_foundation': m0001,
  '0002_email_recovery': m0002,
  '0003_realtime': m0003,
  '0004_ai_gateway': m0004,
};

export const migrationProvider: MigrationProvider = {
  getMigrations: async () => migrations,
};
