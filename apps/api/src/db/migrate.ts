import { Migrator, type MigrationResultSet } from 'kysely';
import type { DB } from './database.js';
import { migrationProvider } from './migrations/index.js';

export function createMigrator(db: DB) {
  return new Migrator({ db, provider: migrationProvider });
}

export function assertMigrationSuccess({ error, results }: MigrationResultSet): void {
  const failed = results?.find((r) => r.status === 'Error');
  if (error || failed) {
    throw new Error(`Migration failed${failed ? ` at ${failed.migrationName}` : ''}: ${String(error)}`);
  }
}
