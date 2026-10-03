import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '../src/lib/crypto.js';
import { browserHeaders, createTestApp, newUser, registerNative, resetDb, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());
beforeEach(async () => resetDb(t));

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.find((c) => c.name === 'chatme_session');

describe('registration', () => {
  it('web clients get an httpOnly cookie and never see the token', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: browserHeaders,
      payload: newUser({ device: { platform: 'web', name: 'Chrome on Android' }, locale: 'ar', timezone: 'Asia/Dubai' }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.token).toBeUndefined();
    expect(body.user.locale).toBe('ar');
    expect(body.user.timezone).toBe('Asia/Dubai');
    expect(body.user.emailVerified).toBe(false);
    const cookie = res.cookies.find((c) => c.name === 'chatme_session')!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(cookie.value.length).toBeGreaterThanOrEqual(43);
  });

  it('native clients get a bearer token and no cookie', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/v1/auth/register', headers: browserHeaders, payload: newUser() });
    expect(res.statusCode).toBe(201);
    expect(res.json().token).toMatch(/^[\w-]{43}$/);
    expect(cookieOf(res)).toBeUndefined();
  });

  it('stores only a hash of the session token and an Argon2id password hash', async () => {
    const { token, user, body } = await registerNative(t);
    const session = await t.db.selectFrom('sessions').selectAll().where('user_id', '=', user.id).executeTakeFirstOrThrow();
    expect(Buffer.compare(session.token_hash, hashToken(token))).toBe(0);
    expect(session.token_hash.toString('utf8')).not.toContain(token);
    const cred = await t.db.selectFrom('user_credentials').selectAll().where('user_id', '=', user.id).executeTakeFirstOrThrow();
    expect(cred.password_hash).toMatch(/^\$argon2id\$/);
    expect(cred.password_hash).not.toContain(body.password);
  });

  it('normalises email and username case and rejects duplicates', async () => {
    const first = newUser({ email: 'Ada@Example.com', username: 'Ada_L' });
    const ok = await t.app.inject({ method: 'POST', url: '/v1/auth/register', headers: browserHeaders, payload: first });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().user).toMatchObject({ email: 'ada@example.com', username: 'ada_l' });

    const dupEmail = await t.app.inject({ method: 'POST', url: '/v1/auth/register', headers: browserHeaders, payload: newUser({ email: 'ADA@example.com' }) });
    expect(dupEmail.statusCode).toBe(409);
    expect(dupEmail.json().error.code).toBe('conflict_email');

    const dupUser = await t.app.inject({ method: 'POST', url: '/v1/auth/register', headers: browserHeaders, payload: newUser({ username: 'ADA_l' }) });
    expect(dupUser.statusCode).toBe(409);
    expect(dupUser.json().error.code).toBe('conflict_username');
  });

  it('allows exactly one winner when the same username is registered concurrently', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        t.app.inject({ method: 'POST', url: '/v1/auth/register', headers: browserHeaders, payload: newUser({ username: 'race_name' }) }),
      ),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(7);
    const count = await t.db.selectFrom('users').select((eb) => eb.fn.countAll().as('n')).where('username', '=', 'race_name').executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(1);
    // No orphaned partial accounts from the losing transactions.
    const identities = await t.db.selectFrom('user_identities').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow();
    expect(Number(identities.n)).toBe(1);
  });

  it.each([
    ['short password', { password: 'short' }, 'password'],
    ['bad email', { email: 'not-an-email' }, 'email'],
    ['username starting with digit', { username: '1abc' }, 'username'],
    ['control chars in display name', { displayName: 'evil\u0007name' }, 'displayName'],
    ['unknown locale', { locale: 'xx' }, 'locale'],
    ['invalid timezone', { timezone: 'Mars/Olympus' }, 'timezone'],
    ['oversized password', { password: 'a'.repeat(129) }, 'password'],
  ])('rejects %s with field-level errors', async (_name, override, field) => {
    const res = await t.app.inject({ method: 'POST', url: '/v1/auth/register', headers: browserHeaders, payload: newUser(override) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
    expect(Object.keys(res.json().error.fields)).toContain(field);
  });

  it('rejects malformed JSON without a 500', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { ...browserHeaders, 'content-type': 'application/json' },
      payload: '{"email":',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
  });
});

describe('login', () => {
  it('returns the same error for wrong password and unknown email', async () => {
    const { body } = await registerNative(t);
    const wrong = await t.app.inject({ method: 'POST', url: '/v1/auth/login', headers: browserHeaders, payload: { email: body.email, password: 'nope-nope-nope', device: body.device } });
    const unknown = await t.app.inject({ method: 'POST', url: '/v1/auth/login', headers: browserHeaders, payload: { email: 'ghost@example.com', password: 'nope-nope-nope', device: body.device } });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('invalid_credentials');
    expect(unknown.json().error.code).toBe('invalid_credentials');
  });

  it('creates a new device session per login and records an audit trail', async () => {
    const { body, user } = await registerNative(t);
    const res = await t.app.inject({ method: 'POST', url: '/v1/auth/login', headers: browserHeaders, payload: { email: body.email.toUpperCase(), password: body.password, device: { platform: 'web' } } });
    expect(res.statusCode).toBe(200);
    expect(cookieOf(res)).toBeDefined();
    const actions = await t.db.selectFrom('audit_events').select('action').where('user_id', '=', user.id).orderBy('id').execute();
    expect(actions.map((a) => a.action)).toEqual(['auth.register', 'auth.login']);
  });
});

describe('authenticated requests', () => {
  it('accepts bearer tokens and cookies; rejects garbage', async () => {
    const { auth, user } = await registerNative(t);
    expect((await t.app.inject({ url: '/v1/me', headers: auth })).json().id).toBe(user.id);

    const web = await t.app.inject({ method: 'POST', url: '/v1/auth/register', headers: browserHeaders, payload: newUser({ device: { platform: 'web' } }) });
    const cookie = cookieOf(web)!;
    const me = await t.app.inject({ url: '/v1/me', cookies: { chatme_session: cookie.value } });
    expect(me.statusCode).toBe(200);

    expect((await t.app.inject({ url: '/v1/me' })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/v1/me', headers: { authorization: 'Bearer forged' } })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${'x'.repeat(5000)}` } })).statusCode).toBe(401);
  });

  it('rejects expired and idle sessions and deletes them', async () => {
    const { auth, sessionId } = await registerNative(t);
    await t.db.updateTable('sessions').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', sessionId).execute();
    expect((await t.app.inject({ url: '/v1/me', headers: auth })).statusCode).toBe(401);
    expect(await t.db.selectFrom('sessions').select('id').where('id', '=', sessionId).executeTakeFirst()).toBeUndefined();

    const second = await registerNative(t);
    await t.db.updateTable('sessions').set({ last_seen_at: new Date(Date.now() - t.config.sessionIdleMs - 1000) }).where('id', '=', second.sessionId).execute();
    expect((await t.app.inject({ url: '/v1/me', headers: second.auth })).statusCode).toBe(401);
  });
});

describe('CSRF protection for cookie sessions', () => {
  async function webCookie() {
    const res = await t.app.inject({ method: 'POST', url: '/v1/auth/register', headers: browserHeaders, payload: newUser({ device: { platform: 'web' } }) });
    return cookieOf(res)!.value;
  }

  it('blocks mutating requests without the CSRF header', async () => {
    const cookie = await webCookie();
    const res = await t.app.inject({ method: 'PATCH', url: '/v1/me/profile', cookies: { chatme_session: cookie }, payload: { bio: 'x' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf_failed');
  });

  it('blocks requests from an origin that is not allow-listed', async () => {
    const cookie = await webCookie();
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/v1/me/profile',
      cookies: { chatme_session: cookie },
      headers: { ...browserHeaders, origin: 'https://evil.example' },
      payload: { bio: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('blocks login CSRF (unauthenticated form posts)', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'a@b.co', password: 'x', device: { platform: 'web' } } });
    expect(res.statusCode).toBe(403);
  });

  it('allows legitimate browser requests', async () => {
    const cookie = await webCookie();
    const res = await t.app.inject({ method: 'PATCH', url: '/v1/me/profile', cookies: { chatme_session: cookie }, headers: browserHeaders, payload: { bio: 'hello' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().bio).toBe('hello');
  });

  it('answers CORS preflight only for allow-listed origins', async () => {
    const ok = await t.app.inject({ method: 'OPTIONS', url: '/v1/me/profile', headers: { origin: 'https://app.chatme.test', 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'x-chatme-csrf' } });
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.chatme.test');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const bad = await t.app.inject({ method: 'OPTIONS', url: '/v1/me/profile', headers: { origin: 'https://evil.example', 'access-control-request-method': 'PATCH' } });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('sessions and devices', () => {
  async function loginAgain(body: ReturnType<typeof newUser>, platform = 'android') {
    const res = await t.app.inject({ method: 'POST', url: '/v1/auth/login', headers: browserHeaders, payload: { email: body.email, password: body.password, device: { platform, name: `${platform} device` } } });
    return { authorization: `Bearer ${res.json().token}` };
  }

  it('lists sessions with the current one marked', async () => {
    const a = await registerNative(t);
    await loginAgain(a.body);
    const res = await t.app.inject({ url: '/v1/sessions', headers: a.auth });
    const sessions = res.json().sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(sessions.find((s: { current: boolean }) => s.current).id).toBe(a.sessionId);
  });

  it('logs out other devices but keeps the current one', async () => {
    const a = await registerNative(t);
    const b = await loginAgain(a.body);
    const c = await loginAgain(a.body);
    const res = await t.app.inject({ method: 'POST', url: '/v1/sessions/revoke-others', headers: a.auth });
    expect(res.json().revoked).toBe(2);
    expect((await t.app.inject({ url: '/v1/me', headers: a.auth })).statusCode).toBe(200);
    expect((await t.app.inject({ url: '/v1/me', headers: b })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/v1/me', headers: c })).statusCode).toBe(401);
  });

  it("cannot revoke another user's session", async () => {
    const a = await registerNative(t);
    const b = await registerNative(t);
    const res = await t.app.inject({ method: 'DELETE', url: `/v1/sessions/${b.sessionId}`, headers: a.auth });
    expect(res.statusCode).toBe(404);
    expect((await t.app.inject({ url: '/v1/me', headers: b.auth })).statusCode).toBe(200);
  });

  it('logout invalidates the token immediately', async () => {
    const a = await registerNative(t);
    expect((await t.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: a.auth })).statusCode).toBe(204);
    expect((await t.app.inject({ url: '/v1/me', headers: a.auth })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: a.auth })).statusCode).toBe(401);
  });
});

describe('account deletion', () => {
  it('requires the password, removes personal data, keeps the audit record', async () => {
    const a = await registerNative(t);
    const wrong = await t.app.inject({ method: 'POST', url: '/v1/me/delete', headers: a.auth, payload: { password: 'wrong-password' } });
    expect(wrong.statusCode).toBe(401);
    expect((await t.app.inject({ url: '/v1/me', headers: a.auth })).statusCode).toBe(200);

    const ok = await t.app.inject({ method: 'POST', url: '/v1/me/delete', headers: a.auth, payload: { password: a.body.password } });
    expect(ok.statusCode).toBe(204);
    expect((await t.app.inject({ url: '/v1/me', headers: a.auth })).statusCode).toBe(401);
    for (const table of ['users', 'user_identities', 'user_credentials', 'user_preferences', 'devices', 'sessions'] as const) {
      const col = table === 'users' ? 'id' : 'user_id';
      const rows = await t.db.selectFrom(table).select(col as never).where(col as never, '=', a.user.id).execute();
      expect(rows, table).toHaveLength(0);
    }
    const audit = await t.db.selectFrom('audit_events').select('action').where('user_id', '=', a.user.id).where('action', '=', 'account.deleted').execute();
    expect(audit).toHaveLength(1);

    const relogin = await t.app.inject({ method: 'POST', url: '/v1/auth/login', headers: browserHeaders, payload: { email: a.body.email, password: a.body.password, device: a.body.device } });
    expect(relogin.statusCode).toBe(401);
    // The email can be used again for a fresh account.
    const again = await t.app.inject({ method: 'POST', url: '/v1/auth/register', headers: browserHeaders, payload: newUser({ email: a.body.email }) });
    expect(again.statusCode).toBe(201);
  });
});

describe('secrets never reach logs', () => {
  it('does not log passwords, tokens or cookies', async () => {
    t.logs.length = 0;
    const a = await registerNative(t);
    await t.app.inject({ url: '/v1/me', headers: a.auth });
    await t.app.inject({ method: 'POST', url: '/v1/auth/login', headers: browserHeaders, payload: { email: a.body.email, password: 'a-wrong-password', device: { platform: 'web' } } });
    const all = t.logs.join('\n');
    expect(t.logs.length).toBeGreaterThan(0);
    expect(all).not.toContain(a.body.password);
    expect(all).not.toContain('a-wrong-password');
    expect(all).not.toContain(a.token);
  });
});
