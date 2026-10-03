/**
 * Usage: pnpm db:migrate [latest|up|down]
 * Production deploys run `latest` as a release step before new code takes traffic.
 */
import { createDatabase } from './database.js';
import { assertMigrationSuccess, createMigrator } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const direction = process.argv[2] ?? 'latest';
const { db } = createDatabase({ url, poolMax: 1 });
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
