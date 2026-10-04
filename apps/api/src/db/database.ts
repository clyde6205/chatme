import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

export type DB = Kysely<Database>;

export type SslMode = 'disable' | 'require' | 'verify-full';

export interface DatabaseOptions {
  url: string;
  poolMax: number;
  ssl?: SslMode;
  caCert?: string;
  applicationName?: string;
}

/** node-postgres TLS options for a mode. `require` encrypts but trusts any certificate. */
export function sslOptions(mode: SslMode = 'disable', caCert?: string): pg.PoolConfig['ssl'] {
  if (mode === 'disable') return undefined;
  if (mode === 'require') return { rejectUnauthorized: false };
  return { rejectUnauthorized: true, ca: caCert };
}

export function createDatabase(opts: DatabaseOptions): { db: DB; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString: opts.url,
    max: opts.poolMax,
    ssl: sslOptions(opts.ssl, opts.caCert),
    // Fail fast instead of queueing forever when the database is unreachable.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    // Client-side query timeout. A server-side statement_timeout startup parameter would be
    // rejected by transaction poolers (Supabase Supavisor, PgBouncer), so the server-side
    // limit is set on the database role instead (docs/operations.md).
    query_timeout: 10_000,
    application_name: opts.applicationName ?? 'chatme-api',
  });
  // An idle client erroring (e.g. DB restart) must not crash the process.
  pool.on('error', () => {});
  return { db: new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }), pool };
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
}
