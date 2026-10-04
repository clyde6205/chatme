import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/database.js';
import { assertMigrationSuccess, createMigrator } from '../src/db/migrate.js';
import { pruneExpiredSessions } from '../src/modules/auth/service.js';
import { bucketOf, evaluateFlag } from '../src/modules/flags/service.js';
import { browserHeaders, createTestApp, newUser, registerNative, resetDb, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ METRICS_TOKEN: 'metrics-token-for-tests-123456' });
});
afterAll(async () => t.close());
beforeEach(async () => resetDb(t));

describe('profile and preferences', () => {
  it('merges partial privacy and notification updates', async () => {
    const a = await registerNative(t);
    const r1 = await t.app.inject({ method: 'PATCH', url: '/v1/me/preferences', headers: a.auth, payload: { privacy: { showPresence: false } } });
    expect(r1.statusCode).toBe(200);
    const r2 = await t.app.inject({ method: 'PATCH', url: '/v1/me/preferences', headers: a.auth, payload: { privacy: { whoCanMessage: 'contacts' }, locale: 'ja', performanceMode: 'low' } });
    const me = r2.json();
    expect(me.privacy).toMatchObject({ showPresence: false, whoCanMessage: 'contacts', sendReadReceipts: true });
    expect(me.locale).toBe('ja');
    expect(me.performanceMode).toBe('low');
  });

  it('applies concurrent updates to different keys without lost writes', async () => {
    const a = await registerNative(t);
    await Promise.all([
      t.app.inject({ method: 'PATCH', url: '/v1/me/preferences', headers: a.auth, payload: { privacy: { showPresence: false } } }),
      t.app.inject({ method: 'PATCH', url: '/v1/me/preferences', headers: a.auth, payload: { privacy: { discoverable: false } } }),
      t.app.inject({ method: 'PATCH', url: '/v1/me/preferences', headers: a.auth, payload: { notifications: { calls: false } } }),
    ]);
    const me = (await t.app.inject({ url: '/v1/me', headers: a.auth })).json();
    expect(me.privacy.showPresence).toBe(false);
    expect(me.privacy.discoverable).toBe(false);
    expect(me.notifications.calls).toBe(false);
  });

  it.each([
    [{ privacy: { whoCanMessage: 'aliens' } }],
    [{ privacy: { injected: true } }],
    [{ notifications: { quietHours: { enabled: true } } }],
    [{ notifications: { quietHours: { enabled: true, start: '25:00', end: '07:00' } } }],
    [{ timezone: 'Not/AZone' }],
    [{ isAdmin: true }],
  ])('rejects invalid preference payload %j', async (payload) => {
    const a = await registerNative(t);
    const res = await t.app.inject({ method: 'PATCH', url: '/v1/me/preferences', headers: a.auth, payload });
    expect(res.statusCode).toBe(400);
  });

  it('changes username with conflict detection and audit', async () => {
    const a = await registerNative(t);
    const b = await registerNative(t);
    const clash = await t.app.inject({ method: 'PATCH', url: '/v1/me/profile', headers: a.auth, payload: { username: b.user.username.toUpperCase() } });
    expect(clash.statusCode).toBe(409);
    const ok = await t.app.inject({ method: 'PATCH', url: '/v1/me/profile', headers: a.auth, payload: { username: 'Fresh_Name', displayName: '  Ada  ', bio: '' } });
    expect(ok.json()).toMatchObject({ username: 'fresh_name', displayName: 'Ada', bio: null });
    const audit = await t.db.selectFrom('audit_events').select('metadata').where('action', '=', 'profile.username_changed').executeTakeFirstOrThrow();
    expect(audit.metadata).toMatchObject({ to: 'fresh_name' });
  });
});

describe('rate limiting', () => {
  it('limits auth attempts and reports rate_limited', async () => {
    const limited = await createTestApp({ RATE_LIMIT_AUTH_PER_MIN: '3' });
    try {
      const payload = { email: 'victim@example.com', password: 'guess-guess-guess', device: { platform: 'web' } };
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) {
        codes.push((await limited.app.inject({ method: 'POST', url: '/v1/auth/login', headers: browserHeaders, payload })).statusCode);
      }
      expect(codes).toEqual([401, 401, 401, 429, 429]);
      const res = await limited.app.inject({ method: 'POST', url: '/v1/auth/login', headers: browserHeaders, payload });
      expect(res.json().error.code).toBe('rate_limited');
    } finally {
      await limited.close();
    }
  });
});

describe('health and degradation', () => {
  it('reports ready when the database is reachable', async () => {
    const res = await t.app.inject({ url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.database.ok).toBe(true);
  });

  it('stays alive but not ready, and returns 503 (not 500) when the database is down', async () => {
    const down = await createTestApp({}, 'postgres://nobody:nothing@127.0.0.1:1/none');
    try {
      expect((await down.app.inject({ url: '/health/live' })).statusCode).toBe(200);
      expect((await down.app.inject({ url: '/health/ready' })).statusCode).toBe(503);
      const res = await down.app.inject({ method: 'POST', url: '/v1/auth/login', headers: browserHeaders, payload: { email: 'a@b.co', password: 'whatever-123', device: { platform: 'web' } } });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('service_unavailable');
    } finally {
      await down.close();
    }
  });
});

describe('metrics', () => {
  it('requires the scrape token and exposes request histograms by route pattern', async () => {
    const a = await registerNative(t);
    await t.app.inject({ method: 'DELETE', url: '/v1/sessions/00000000-0000-0000-0000-000000000000', headers: a.auth });
    expect((await t.app.inject({ url: '/metrics' })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/metrics', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    const res = await t.app.inject({ url: '/metrics', headers: { authorization: 'Bearer metrics-token-for-tests-123456' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('chatme_http_request_duration_seconds_bucket');
    expect(res.body).toContain('route="/v1/sessions/:id"');
    expect(res.body).not.toContain('00000000-0000-0000-0000-000000000000');
  });

  it('ingests client performance samples and rejects junk', async () => {
    const good = await t.app.inject({
      method: 'POST',
      url: '/v1/telemetry/perf',
      headers: browserHeaders,
      payload: { platform: 'web', deviceClass: 'low', connection: '3g', appVersion: '0.1.0', samples: [{ name: 'LCP', value: 1800 }, { name: 'app_shell_render', value: 120 }] },
    });
    expect(good.statusCode).toBe(202);
    const bad = await t.app.inject({ method: 'POST', url: '/v1/telemetry/perf', headers: browserHeaders, payload: { platform: 'web', deviceClass: 'low', connection: '3g', appVersion: '1', samples: [{ name: 'LCP', value: -1 }] } });
    expect(bad.statusCode).toBe(400);
    const metrics = await t.app.inject({ url: '/metrics', headers: { authorization: 'Bearer metrics-token-for-tests-123456' } });
    expect(metrics.body).toMatch(/chatme_client_perf_ms_count\{name="LCP",platform="web",device_class="low",connection="3g"\} 1/);
  });
});

describe('feature flags', () => {
  it('evaluates kill switch, conditions and stable percentage rollout', () => {
    const flag = { key: 'chat.voice_notes', enabled: true, rollout_percent: 50, conditions: { platforms: ['android'] } };
    expect(evaluateFlag({ ...flag, enabled: false }, { subject: 'u1', platform: 'android' })).toBe(false);
    expect(evaluateFlag(flag, { subject: 'u1', platform: 'web' })).toBe(false);
    expect(evaluateFlag({ ...flag, rollout_percent: 100 }, { subject: 'u1', platform: 'android' })).toBe(true);
    expect(evaluateFlag({ ...flag, rollout_percent: 0 }, { subject: 'u1', platform: 'android' })).toBe(false);
    // Stable per subject, and roughly proportional across many subjects.
    expect(bucketOf('k', 'same')).toBe(bucketOf('k', 'same'));
    const on = Array.from({ length: 2000 }, (_, i) => evaluateFlag(flag, { subject: `s${i}`, platform: 'android' })).filter(Boolean).length;
    expect(on).toBeGreaterThan(900);
    expect(on).toBeLessThan(1100);
  });

  it('serves evaluated flags from the database', async () => {
    await t.db.insertInto('feature_flags').values([
      { key: 'ui.low_end_lists', description: 'test', enabled: true, rollout_percent: 100, conditions: JSON.stringify({ deviceClasses: ['low'] }) },
      { key: 'ui.disabled', description: 'test', enabled: false, rollout_percent: 100, conditions: '{}' },
    ]).execute();
    const fresh = await createTestApp();
    try {
      const res = await fresh.app.inject({ url: '/v1/flags?deviceClass=low&installId=6f1c2a3e-1111-4222-8333-944445555666' });
      expect(res.json().flags).toEqual({ 'ui.low_end_lists': true, 'ui.disabled': false });
    } finally {
      await fresh.close();
    }
  });
});

describe('session pruning', () => {
  it('removes expired sessions and their device rows only', async () => {
    const a = await registerNative(t);
    const b = await registerNative(t);
    await t.db.updateTable('sessions').set({ expires_at: new Date(Date.now() - 1) }).where('id', '=', a.sessionId).execute();
    expect(await pruneExpiredSessions(t.db)).toBe(1);
    const left = await t.db.selectFrom('sessions').select('id').execute();
    expect(left.map((s) => s.id)).toEqual([b.sessionId]);
  });
});

describe('configuration', () => {
  it('refuses unsafe production settings', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x@y/z', WEB_ORIGINS: 'http://chatme.pro' })).toThrow(/COOKIE_SECURE.*METRICS_TOKEN.*https/);
    expect(() =>
      loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x@y/z', WEB_ORIGINS: 'https://chatme.pro', COOKIE_SECURE: 'true', METRICS_TOKEN: 'x'.repeat(32) }),
    ).toThrow(/WEB_BASE_URL.*EMAIL_PROVIDER.*EMAIL_FROM.*DATABASE_SSL/);
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://x@y/z',
        WEB_ORIGINS: 'https://chatme.pro',
        COOKIE_SECURE: 'true',
        METRICS_TOKEN: 'x'.repeat(32),
        WEB_BASE_URL: 'https://chatme.pro',
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_test_key_123',
        EMAIL_FROM: 'CHATme <no-reply@mail.chatme.pro>',
        DATABASE_SSL: 'require',
      }),
    ).not.toThrow();
    // Resend without a key, or certificate verification without a CA, fails in every environment.
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x@y/z', EMAIL_PROVIDER: 'resend' })).toThrow(/RESEND_API_KEY/);
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x@y/z', DATABASE_SSL: 'verify-full' })).toThrow(/DATABASE_CA_CERT/);
  });

  it('uses the __Host- cookie prefix when cookies are secure', async () => {
    const secure = await createTestApp({ COOKIE_SECURE: 'true' });
    try {
      const res = await secure.app.inject({ method: 'POST', url: '/v1/auth/register', headers: browserHeaders, payload: newUser({ device: { platform: 'web' } }) });
      const cookie = res.cookies.find((c) => c.name === '__Host-chatme_session');
      expect(cookie).toMatchObject({ secure: true, httpOnly: true, path: '/' });
    } finally {
      await secure.close();
    }
  });
});

describe('migrations', () => {
  it('roll back to empty and forward to latest cleanly', async () => {
    const { db } = createDatabase({ url: process.env.TEST_DATABASE_URL!, poolMax: 1 });
    try {
      const migrator = createMigrator(db);
      const all = await migrator.getMigrations();
      for (let i = 0; i < all.length; i++) assertMigrationSuccess(await migrator.migrateDown());
      const tables = await sql<{ n: number }>`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name not like 'kysely_%'`.execute(db);
      expect(tables.rows[0]!.n).toBe(0);
      assertMigrationSuccess(await migrator.migrateToLatest());
      const pending = (await migrator.getMigrations()).filter((m) => !m.executedAt);
      expect(pending).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });
});
