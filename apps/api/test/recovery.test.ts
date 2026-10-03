import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_RESET_PER_HOUR, MAX_VERIFY_PER_HOUR } from '../src/modules/auth/recovery.js';
import { browserHeaders, createTestApp, registerNative, resetDb, tokenFrom, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDb(t);
  t.mail.length = 0;
});

const post = (url: string, payload: unknown, headers: Record<string, string> = browserHeaders) => t.app.inject({ method: 'POST', url, payload: payload as object, headers });
const me = (auth: Record<string, string>) => t.app.inject({ method: 'GET', url: '/v1/me', headers: auth });
const login = (email: string, password: string) => post('/v1/auth/login', { email, password, device: { platform: 'android' } });

describe('email verification', () => {
  it('sends a localized verification email on registration and verifies with the link token', async () => {
    const u = await registerNative(t, { locale: 'es' });
    expect(u.user.emailVerified).toBe(false);
    const mail = await t.flushMail();
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toBe('Confirma tu correo en CHATme');
    const token = tokenFrom(mail, u.body.email, '/verify-email');
    // The link points at the web app and carries the token in the fragment, which never reaches servers.
    expect(mail[0]!.text).toContain(`https://app.chatme.test/verify-email#token=${token}`);

    // No session needed: the link may be opened on another device.
    expect((await post('/v1/auth/verify-email', { token })).statusCode).toBe(204);
    expect((await me(u.auth)).json().emailVerified).toBe(true);
    // Single use.
    const again = await post('/v1/auth/verify-email', { token });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('invalid_token');
  });

  it('rejects expired, malformed and wrong-purpose tokens', async () => {
    const u = await registerNative(t);
    const token = tokenFrom(await t.flushMail(), u.body.email, '/verify-email');
    await t.db.updateTable('verification_tokens').set({ expires_at: new Date(Date.now() - 1000) }).execute();
    expect((await post('/v1/auth/verify-email', { token })).json().error.code).toBe('invalid_token');
    expect((await post('/v1/auth/verify-email', { token: 'short' })).statusCode).toBe(400);
    expect((await post('/v1/auth/verify-email', { token: 'x'.repeat(43) })).json().error.code).toBe('invalid_token');

    // A reset token is not a verification token.
    await post('/v1/auth/password/forgot', { email: u.body.email });
    const reset = tokenFrom(await t.flushMail(), u.body.email, '/reset-password');
    expect((await post('/v1/auth/verify-email', { token: reset })).json().error.code).toBe('invalid_token');
  });

  it('resend issues a new link, invalidates the old one and is capped per hour', async () => {
    const u = await registerNative(t);
    const first = tokenFrom(await t.flushMail(), u.body.email, '/verify-email');
    expect((await post('/v1/auth/verify-email/resend', {}, u.auth)).statusCode).toBe(204);
    const second = tokenFrom(await t.flushMail(), u.body.email, '/verify-email');
    expect(second).not.toBe(first);
    expect((await post('/v1/auth/verify-email', { token: first })).statusCode).toBe(400);

    for (let i = 2; i < MAX_VERIFY_PER_HOUR; i++) expect((await post('/v1/auth/verify-email/resend', {}, u.auth)).statusCode).toBe(204);
    const capped = await post('/v1/auth/verify-email/resend', {}, u.auth);
    expect(capped.statusCode).toBe(429);
    expect(capped.json().error.code).toBe('rate_limited');
    expect((await post('/v1/auth/verify-email/resend', {}, {})).statusCode).toBe(403); // no CSRF header, no bearer
  });

  it('resend is a no-op once verified', async () => {
    const u = await registerNative(t);
    await post('/v1/auth/verify-email', { token: tokenFrom(await t.flushMail(), u.body.email, '/verify-email') });
    t.mail.length = 0;
    expect((await post('/v1/auth/verify-email/resend', {}, u.auth)).statusCode).toBe(204);
    expect(await t.flushMail()).toHaveLength(0);
  });

  it('does not verify an address the account no longer uses', async () => {
    const u = await registerNative(t);
    const token = tokenFrom(await t.flushMail(), u.body.email, '/verify-email');
    await t.db.updateTable('user_identities').set({ value: 'changed@example.com' }).where('user_id', '=', u.user.id).execute();
    expect((await post('/v1/auth/verify-email', { token })).statusCode).toBe(204);
    expect((await me(u.auth)).json().emailVerified).toBe(false);
  });
});

describe('password reset', () => {
  it('answers identically for known and unknown emails and only mails real accounts', async () => {
    const u = await registerNative(t);
    await t.flushMail();
    t.mail.length = 0;
    const known = await post('/v1/auth/password/forgot', { email: u.body.email });
    const unknown = await post('/v1/auth/password/forgot', { email: 'nobody@example.com' });
    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(known.body).toBe(unknown.body);
    const mail = await t.flushMail();
    expect(mail.map((m) => m.to)).toEqual([u.body.email]);
  });

  it('resets the password, signs out every session, and notifies the user', async () => {
    const u = await registerNative(t);
    const other = await login(u.body.email, u.body.password);
    await post('/v1/auth/password/forgot', { email: u.body.email.toUpperCase() });
    const token = tokenFrom(await t.flushMail(), u.body.email, '/reset-password');

    const res = await post('/v1/auth/password/reset', { token, password: 'a brand new passphrase' });
    expect(res.statusCode).toBe(204);
    expect((await me(u.auth)).statusCode).toBe(401);
    expect((await me({ authorization: `Bearer ${other.json().token}` })).statusCode).toBe(401);
    expect((await login(u.body.email, u.body.password)).statusCode).toBe(401);
    const fresh = await login(u.body.email, 'a brand new passphrase');
    expect(fresh.statusCode).toBe(200);
    // Receiving the email proved control of the address.
    expect(fresh.json().user.emailVerified).toBe(true);
    const mail = await t.flushMail();
    expect(mail.some((m) => m.subject === 'Your CHATme password was changed')).toBe(true);
    // Reuse fails.
    expect((await post('/v1/auth/password/reset', { token, password: 'yet another passphrase' })).json().error.code).toBe('invalid_token');
  });

  it('two concurrent uses of one token: exactly one succeeds', async () => {
    const u = await registerNative(t);
    await post('/v1/auth/password/forgot', { email: u.body.email });
    const token = tokenFrom(await t.flushMail(), u.body.email, '/reset-password');
    const results = await Promise.all([
      post('/v1/auth/password/reset', { token, password: 'first new passphrase' }),
      post('/v1/auth/password/reset', { token, password: 'second new passphrase' }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([204, 400]);
  });

  it('a newer reset link invalidates the older one', async () => {
    const u = await registerNative(t);
    await post('/v1/auth/password/forgot', { email: u.body.email });
    const first = tokenFrom(await t.flushMail(), u.body.email, '/reset-password');
    await post('/v1/auth/password/forgot', { email: u.body.email });
    const second = tokenFrom(await t.flushMail(), u.body.email, '/reset-password');
    expect((await post('/v1/auth/password/reset', { token: first, password: 'some new passphrase' })).statusCode).toBe(400);
    expect((await post('/v1/auth/password/reset', { token: second, password: 'some new passphrase' })).statusCode).toBe(204);
  });

  it('caps reset emails per account per hour, silently', async () => {
    const u = await registerNative(t);
    await t.flushMail();
    t.mail.length = 0;
    for (let i = 0; i < MAX_RESET_PER_HOUR + 2; i++) expect((await post('/v1/auth/password/forgot', { email: u.body.email })).statusCode).toBe(202);
    expect((await t.flushMail()).length).toBe(MAX_RESET_PER_HOUR);
  });

  it('enforces the password policy on reset', async () => {
    const u = await registerNative(t);
    await post('/v1/auth/password/forgot', { email: u.body.email });
    const token = tokenFrom(await t.flushMail(), u.body.email, '/reset-password');
    const res = await post('/v1/auth/password/reset', { token, password: 'short' });
    expect(res.statusCode).toBe(400);
    // A rejected attempt does not burn the token.
    expect((await post('/v1/auth/password/reset', { token, password: 'long enough passphrase' })).statusCode).toBe(204);
  });

  it('never logs tokens or passwords from these flows', async () => {
    const u = await registerNative(t);
    await post('/v1/auth/password/forgot', { email: u.body.email });
    const token = tokenFrom(await t.flushMail(), u.body.email, '/reset-password');
    await post('/v1/auth/password/reset', { token, password: 'a logged passphrase?' });
    const logs = t.logs.join('\n');
    expect(logs).not.toContain(token);
    expect(logs).not.toContain('a logged passphrase?');
  });
});

describe('change password', () => {
  it('requires the current password, keeps this session, revokes others, notifies', async () => {
    const u = await registerNative(t);
    const other = await login(u.body.email, u.body.password);
    t.mail.length = 0;

    const wrong = await post('/v1/me/password', { currentPassword: 'not it at all', newPassword: 'a new passphrase here' }, u.auth);
    expect(wrong.statusCode).toBe(401);

    const same = await post('/v1/me/password', { currentPassword: u.body.password, newPassword: u.body.password }, u.auth);
    expect(same.statusCode).toBe(400);

    const ok = await post('/v1/me/password', { currentPassword: u.body.password, newPassword: 'a new passphrase here' }, u.auth);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ revokedSessions: 1 });
    expect((await me(u.auth)).statusCode).toBe(200);
    expect((await me({ authorization: `Bearer ${other.json().token}` })).statusCode).toBe(401);
    expect((await t.flushMail()).some((m) => m.subject === 'Your CHATme password was changed')).toBe(true);
  });

  it('a password change burns outstanding reset links', async () => {
    const u = await registerNative(t);
    await post('/v1/auth/password/forgot', { email: u.body.email });
    const token = tokenFrom(await t.flushMail(), u.body.email, '/reset-password');
    await post('/v1/me/password', { currentPassword: u.body.password, newPassword: 'a new passphrase here' }, u.auth);
    expect((await post('/v1/auth/password/reset', { token, password: 'attacker passphrase' })).statusCode).toBe(400);
  });
});

describe('security notifications', () => {
  it('emails on each sign-in and on account deletion (after the user row is gone)', async () => {
    const u = await registerNative(t);
    await login(u.body.email, u.body.password);
    let mail = await t.flushMail();
    const signIns = mail.filter((m) => m.subject === 'New sign-in to your CHATme account');
    expect(signIns).toHaveLength(1);
    expect(signIns[0]!.text).toContain('android');

    const del = await post('/v1/me/delete', { password: u.body.password }, u.auth);
    expect(del.statusCode).toBe(204);
    mail = await t.flushMail();
    expect(mail.at(-1)).toMatchObject({ to: u.body.email, subject: 'Your CHATme account was deleted' });
  });
});
