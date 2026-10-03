import { sql } from 'kysely';
import { createDatabase } from '../src/db/database.js';
import { assertMigrationSuccess, createMigrator } from '../src/db/migrate.js';

/**
 * Integration tests run against a real PostgreSQL (TEST_DATABASE_URL).
 * The schema is wiped and rebuilt from migrations on every run so tests
 * exercise exactly what production migrations produce.
 */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required for API tests (see docs/environment.md)');
  const { db } = createDatabase({ url, poolMax: 1 });
  try {
    await sql`drop schema public cascade`.execute(db);
    await sql`create schema public`.execute(db);
    assertMigrationSuccess(await createMigrator(db).migrateToLatest());
  } finally {
    await db.destroy();
  }
}
