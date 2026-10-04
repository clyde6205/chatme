/**
 * Usage: pnpm db:migrate [latest|up|down]
 * Production deploys run `latest` as a release step before new code takes traffic.
 */
import { createDatabase, type SslMode } from './database.js';
import { assertMigrationSuccess, createMigrator } from './migrate.js';

// Migrations prefer a direct (non-pooled) connection: DDL and long transactions do not belong on a transaction pooler.
const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL or DATABASE_URL is required');
  process.exit(1);
}
const direction = process.argv[2] ?? 'latest';
const ssl = (process.env.DATABASE_SSL ?? 'disable') as SslMode;
if (!['disable', 'require', 'verify-full'].includes(ssl)) {
  console.error(`Invalid DATABASE_SSL "${ssl}"`);
  process.exit(1);
}
const { db } = createDatabase({
  url,
  poolMax: 1,
  ssl,
  caCert: process.env.DATABASE_CA_CERT?.replace(/\\n/g, '\n'),
  applicationName: 'chatme-migrate',
});
const migrator = createMigrator(db);

try {
  const result =
    direction === 'down' ? await migrator.migrateDown()
    : direction === 'up' ? await migrator.migrateUp()
    : direction === 'latest' ? await migrator.migrateToLatest()
    : (() => { throw new Error(`Unknown direction "${direction}"`); })();
  for (const r of result.results ?? []) console.log(`${r.status}: ${r.migrationName} (${r.direction})`);
  assertMigrationSuccess(result);
  if (!result.results?.length) console.log('Nothing to migrate.');
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
