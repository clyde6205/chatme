import { Writable } from 'node:stream';
import { sql } from 'kysely';
import { CSRF_HEADER } from '@chatme/contracts';
import { buildApp, LOG_REDACT_PATHS } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createDatabase } from '../src/db/database.js';
import type { MemoryEmailProvider } from '../src/modules/email/provider.js';
import type { RuntimeOverrides } from '../src/runtime.js';

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    WEB_ORIGINS: 'https://app.chatme.test',
    LOG_LEVEL: 'info',
    RATE_LIMIT_AUTH_PER_MIN: '1000',
    RATE_LIMIT_GLOBAL_PER_MIN: '10000',
    EMAIL_PROVIDER: 'memory',
    WEB_BASE_URL: 'https://app.chatme.test',
    ...overrides,
  });
}

/** Builds the real app against the test database and captures every log line. */
export async function createTestApp(overrides: Record<string, string> = {}, dbUrl?: string, runtime?: RuntimeOverrides) {
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
    runtime,
  });
  await app.ready();
  return {
    app,
    db,
    config,
    logs,
    /** Emails the app has sent through the in-memory provider. */
    get mail() {
      return (app.runtime.email as MemoryEmailProvider).sent;
    },
    /** Wait for background work, then deliver every due email. */
    async flushMail() {
      await app.runtime.background.idle();
      await app.runtime.outbox.drain();
      return (app.runtime.email as MemoryEmailProvider).sent;
    },
    async close() {
      await app.runtime.drain();
      await app.close();
      await app.runtime.stop();
      await db.destroy();
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;

export async function resetDb(t: TestApp) {
  await sql`truncate users, devices, sessions, audit_events, feature_flags, email_outbox, verification_tokens, user_events, user_event_seq, realtime_presence, realtime_instances restart identity cascade`.execute(t.db);
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

/** Token from the most recent email to `to` whose link contains `path`. */
export function tokenFrom(mail: { to: string; text: string }[], to: string, path: string): string {
  const msg = [...mail].reverse().find((m) => m.to === to && m.text.includes(path));
  if (!msg) throw new Error(`no ${path} email to ${to}`);
  const match = new RegExp(`${path}#token=([A-Za-z0-9_-]{43})`).exec(msg.text);
  if (!match) throw new Error('no token in email');
  return match[1]!;
}
