import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '@chatme/contracts/constants';
import { EmailOutboxWorker, enqueueEmail } from '../src/modules/email/outbox.js';
import { EmailSendError, MemoryEmailProvider } from '../src/modules/email/provider.js';
import { ResendEmailProvider } from '../src/modules/email/resend.js';
import { escapeHtml, renderEmail } from '../src/modules/email/templates.js';
import { createTestApp, resetDb, type TestApp } from './helpers.js';

const silent = { info() {}, warn() {}, error() {} };

describe('email templates', () => {
  it('renders every template in every supported locale with no missing keys', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const template of [
        { kind: 'verify_email', name: 'Ada', link: 'https://chatme.pro/verify-email#token=abc' },
        { kind: 'reset_password', name: 'Ada', link: 'https://chatme.pro/reset-password#token=abc' },
        { kind: 'new_sign_in', name: 'Ada', device: 'Pixel (android)', resetLink: 'https://chatme.pro/forgot-password' },
        { kind: 'password_changed', name: 'Ada', resetLink: 'https://chatme.pro/forgot-password' },
        { kind: 'account_deleted', name: 'Ada' },
      ] as const) {
        const r = renderEmail(template, locale);
        // A missing key renders as the key itself.
        expect(r.subject, `${locale} ${template.kind}`).not.toMatch(/^email\./);
        expect(r.text).not.toMatch(/email\.[a-zA-Z]+/);
        expect(r.html).not.toMatch(/email\.[a-zA-Z]+/);
        expect(r.text).toContain('Ada');
        if ('link' in template) expect(r.text).toContain(template.link);
        expect(r.html).toContain(`lang="${locale}"`);
      }
    }
  });

  it('sets dir=rtl for Arabic and Urdu', () => {
    expect(renderEmail({ kind: 'account_deleted', name: 'x' }, 'ar').html).toContain('dir="rtl"');
    expect(renderEmail({ kind: 'account_deleted', name: 'x' }, 'ur').html).toContain('dir="rtl"');
    expect(renderEmail({ kind: 'account_deleted', name: 'x' }, 'en').html).toContain('dir="ltr"');
  });

  it('escapes user-controlled names and strips bidi overrides', () => {
    const r = renderEmail({ kind: 'verify_email', name: '<img src=x onerror=alert(1)>‮evil', link: 'https://chatme.pro/v#token=a"b' }, 'en');
    expect(r.html).not.toContain('<img');
    expect(r.html).toContain('&lt;img');
    expect(r.html).toContain('a&quot;b');
    expect(r.text).not.toContain('‮');
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('falls back to English for an unknown locale instead of failing', () => {
    expect(renderEmail({ kind: 'account_deleted', name: 'x' }, 'xx').subject).toBe('Your CHATme account was deleted');
  });
});

describe('Resend adapter (against a local mock of the Resend API)', () => {
  let server: Server;
  let base: string;
  const requests: { headers: IncomingMessage['headers']; body: Record<string, unknown> }[] = [];
  let nextStatus: number[] = [];
  let hang = false;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        requests.push({ headers: req.headers, body: JSON.parse(raw || '{}') });
        if (hang) return; // never answer: exercises the timeout
        const status = nextStatus.shift() ?? 200;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(status === 200 ? { id: 'resend_msg_1' } : { name: 'validation_error', message: 'bad', statusCode: status }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    requests.length = 0;
    nextStatus = [];
    hang = false;
  });

  const msg = { to: 'a@example.com', from: 'CHATme <no-reply@mail.chatme.pro>', subject: 'S', html: '<p>h</p>', text: 't', idempotencyKey: 'outbox-1', tag: 'verify_email' };

  it('sends the documented request shape with auth and idempotency headers', async () => {
    const p = new ResendEmailProvider({ apiKey: 're_secret_key', baseUrl: base });
    expect(await p.send({ ...msg, replyTo: 'help@chatme.pro' })).toEqual({ providerMessageId: 'resend_msg_1' });
    const r = requests[0]!;
    expect(r.headers.authorization).toBe('Bearer re_secret_key');
    expect(r.headers['idempotency-key']).toBe('outbox-1');
    expect(r.body).toEqual({ from: msg.from, to: ['a@example.com'], subject: 'S', html: '<p>h</p>', text: 't', reply_to: 'help@chatme.pro', tags: [{ name: 'template', value: 'verify_email' }] });
  });

  it('classifies 429 and 5xx as retryable and other 4xx as permanent', async () => {
    const p = new ResendEmailProvider({ apiKey: 'k'.repeat(12), baseUrl: base });
    for (const [status, retryable] of [[429, true], [500, true], [503, true], [400, false], [401, false], [403, false], [422, false]] as const) {
      nextStatus = [status];
      const err = await p.send(msg).catch((e) => e);
      expect(err, String(status)).toBeInstanceOf(EmailSendError);
      expect(err.retryable, String(status)).toBe(retryable);
      expect(err.message).not.toContain('k'.repeat(12));
    }
  });

  it('treats timeouts and connection failures as retryable', async () => {
    hang = true;
    const slow = new ResendEmailProvider({ apiKey: 'k'.repeat(12), baseUrl: base, timeoutMs: 200 });
    expect((await slow.send(msg).catch((e) => e)).retryable).toBe(true);
    const dead = new ResendEmailProvider({ apiKey: 'k'.repeat(12), baseUrl: 'http://127.0.0.1:1' });
    expect((await dead.send(msg).catch((e) => e)).retryable).toBe(true);
  });
});

describe('email outbox', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  beforeEach(() => resetDb(t));

  const enqueue = (to = 'x@example.com') => enqueueEmail(t.db, { userId: null, to, locale: 'en', template: { kind: 'account_deleted', name: 'X' } });
  const row = (id: string) => t.db.selectFrom('email_outbox').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  it('delivers, records the provider id and clears rendered content', async () => {
    const provider = new MemoryEmailProvider();
    const w = new EmailOutboxWorker(t.db, provider, silent, { from: 'f@x' });
    const id = await enqueue();
    expect(await w.runOnce()).toBe(1);
    expect(provider.sent[0]).toMatchObject({ to: 'x@example.com', idempotencyKey: id, tag: 'account_deleted' });
    const r = await row(id);
    expect(r).toMatchObject({ status: 'sent', attempts: 1, provider: 'memory', provider_message_id: 'mem_1', subject: null, html: null, text_body: null });
  });

  it('retries transient failures with backoff and gives up on permanent ones', async () => {
    const provider = new MemoryEmailProvider();
    const w = new EmailOutboxWorker(t.db, provider, silent, { from: 'f@x', backoffBaseMs: 60_000 });
    const transient = await enqueue('a@example.com');
    provider.failNext = [new EmailSendError('resend 503', true, 503)];
    await w.runOnce();
    const r = await row(transient);
    expect(r.status).toBe('pending');
    expect(r.last_error).toBe('resend 503');
    expect(new Date(r.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 25_000);
    // Not due yet: nothing is claimed.
    expect(await w.runOnce()).toBe(0);

    const permanent = await enqueue('b@example.com');
    provider.failNext = [new EmailSendError('resend 422 invalid to', false, 422)];
    await w.runOnce();
    expect(await row(permanent)).toMatchObject({ status: 'failed', subject: null, html: null, text_body: null });
  });

  it('marks a message failed after the maximum number of attempts', async () => {
    const provider = new MemoryEmailProvider();
    const w = new EmailOutboxWorker(t.db, provider, silent, { from: 'f@x', maxAttempts: 3, backoffBaseMs: 0 });
    const id = await enqueue();
    provider.failNext = [1, 2, 3].map(() => new EmailSendError('resend 500', true, 500));
    for (let i = 0; i < 3; i++) await w.runOnce();
    expect(await row(id)).toMatchObject({ status: 'failed', attempts: 3 });
  });

  it('never double-sends when several workers race for the same rows', async () => {
    const provider = new MemoryEmailProvider();
    const workers = [1, 2, 3, 4].map(() => new EmailOutboxWorker(t.db, provider, silent, { from: 'f@x', batchSize: 3 }));
    const ids = await Promise.all(Array.from({ length: 20 }, (_, i) => enqueue(`r${i}@example.com`)));
    await Promise.all(workers.map((w) => w.drain()));
    expect(provider.sent).toHaveLength(20);
    expect(new Set(provider.sent.map((m) => m.idempotencyKey))).toEqual(new Set(ids));
  });

  it('recovers rows a crashed worker left in sending once their lock expires', async () => {
    const provider = new MemoryEmailProvider();
    const id = await enqueue();
    await t.db.updateTable('email_outbox').set({ status: 'sending', attempts: 1, locked_until: new Date(Date.now() - 1000) }).where('id', '=', id).execute();
    const w = new EmailOutboxWorker(t.db, provider, silent, { from: 'f@x' });
    expect(await w.runOnce()).toBe(1);
    expect(await row(id)).toMatchObject({ status: 'sent', attempts: 2 });
    // The same Idempotency-Key is reused, so the provider drops the duplicate if the first send had landed.
    expect(provider.sent[0]!.idempotencyKey).toBe(id);
  });

  it('does not touch rows still locked by a live worker', async () => {
    const provider = new MemoryEmailProvider();
    const id = await enqueue();
    await t.db.updateTable('email_outbox').set({ status: 'sending', locked_until: new Date(Date.now() + 60_000) }).where('id', '=', id).execute();
    expect(await new EmailOutboxWorker(t.db, provider, silent, { from: 'f@x' }).runOnce()).toBe(0);
  });

  it('a rolled-back transaction leaves no email behind', async () => {
    await t.db
      .transaction()
      .execute(async (trx) => {
        await enqueueEmail(trx, { userId: null, to: 'rollback@example.com', locale: 'en', template: { kind: 'account_deleted', name: 'X' } });
        throw new Error('abort');
      })
      .catch(() => {});
    const rows = await t.db.selectFrom('email_outbox').select('id').where('to_address', '=', 'rollback@example.com').execute();
    expect(rows).toHaveLength(0);
  });
});
