import { Writable } from 'node:stream';
import { sql } from 'kysely';
import { CSRF_HEADER } from '@chatme/contracts';
import { buildApp, LOG_REDACT_PATHS } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createDatabase } from '../src/db/database.js';

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    WEB_ORIGINS: 'https://app.chatme.test',
    LOG_LEVEL: 'info',
    RATE_LIMIT_AUTH_PER_MIN: '1000',
    RATE_LIMIT_GLOBAL_PER_MIN: '10000',
    ...overrides,
  });
}

/** Builds the real app against the test database and captures every log line. */
export async function createTestApp(overrides: Record<string, string> = {}, dbUrl?: string) {
  const config = testConfig(overrides);
  const { db, pool } = createDatabase({ url: dbUrl ?? config.databaseUrl, poolMax: 5 });
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logs.push(chunk.toString());
      cb();
    },
  });
  const app = await buildApp({
    config,
    db,
    pool,
    logger: { level: 'trace', stream, redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' } },
  });
  await app.ready();
  return {
    app,
    db,
    config,
    logs,
    async close() {
      await app.close();
      await db.destroy();
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;

export async function resetDb(t: TestApp) {
  await sql`truncate users, devices, sessions, audit_events, feature_flags restart identity cascade`.execute(t.db);
}

let seq = 0;
export function newUser(overrides: Record<string, unknown> = {}) {
  seq++;
  return {
    email: `user${seq}_${Date.now()}@example.com`,
    password: 'correct horse battery staple',
    username: `user${seq}_${Math.floor(Math.random() * 1e6)}`,
    displayName: `User ${seq}`,
    device: { platform: 'android', name: 'Pixel test', appVersion: '0.1.0' },
    ...overrides,
  };
}

/** Headers a legitimate browser client sends on mutating cookie-authenticated requests. */
export const browserHeaders = { origin: 'https://app.chatme.test', [CSRF_HEADER]: '1' };

export async function registerNative(t: TestApp, overrides: Record<string, unknown> = {}) {
  const body = newUser(overrides);
  const res = await t.app.inject({ method: 'POST', url: '/v1/auth/register', payload: body, headers: browserHeaders });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  const json = res.json();
  return { body, token: json.token as string, user: json.user, sessionId: json.sessionId as string, auth: { authorization: `Bearer ${json.token}` } };
}
