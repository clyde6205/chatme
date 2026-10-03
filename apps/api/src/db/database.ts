import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

export type DB = Kysely<Database>;

export function createDatabase(opts: { url: string; poolMax: number }): { db: DB; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString: opts.url,
    max: opts.poolMax,
    // Fail fast instead of queueing forever when the database is unreachable.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    application_name: 'chatme-api',
  });
  // An idle client erroring (e.g. DB restart) must not crash the process.
  pool.on('error', () => {});
  return { db: new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }), pool };
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
}
