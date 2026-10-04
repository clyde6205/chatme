import { sql } from 'kysely';
import type { DB } from '../../db/database.js';
import { EmailSendError, type EmailProvider } from './provider.js';
import { renderEmail, type EmailTemplate } from './templates.js';

/**
 * Transactional outbox for email.
 *
 * Callers enqueue inside the same database transaction as the change that
 * caused the email (registration, password reset), so an email is never sent
 * for a change that rolled back and never lost for one that committed.
 * A worker on every API instance claims due rows with FOR UPDATE SKIP LOCKED,
 * so any number of instances can run it without double-sending.
 */

export interface EnqueueInput {
  userId: string | null;
  to: string;
  locale: string;
  template: EmailTemplate;
}

export async function enqueueEmail(db: Pick<DB, 'insertInto'>, input: EnqueueInput): Promise<string> {
  const rendered = renderEmail(input.template, input.locale);
  const row = await db
    .insertInto('email_outbox')
    .values({
      user_id: input.userId,
      template: input.template.kind,
      to_address: input.to,
      subject: rendered.subject,
      html: rendered.html,
      text_body: rendered.text,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export interface OutboxOptions {
  from: string;
  replyTo?: string;
  maxAttempts?: number;
  batchSize?: number;
  pollIntervalMs?: number;
  /** How long a claimed row stays locked before another worker may recover it. */
  lockMs?: number;
  /** Base for exponential backoff between attempts. */
  backoffBaseMs?: number;
}

export interface OutboxMetrics {
  onResult(status: 'sent' | 'retry' | 'failed', template: string): void;
}

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };

export class EmailOutboxWorker {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;
  /** Set by stop(): finish the current message, claim nothing new. */
  private halted = false;
  private wakeRequested = false;
  private abort = new AbortController();
  private readonly o: Required<Omit<OutboxOptions, 'replyTo'>> & { replyTo?: string };

  constructor(
    private readonly db: DB,
    private readonly provider: EmailProvider,
    private readonly log: Log,
    opts: OutboxOptions,
    private readonly metrics?: OutboxMetrics,
  ) {
    this.o = {
      maxAttempts: 8,
      batchSize: 10,
      pollIntervalMs: 5_000,
      lockMs: 60_000,
      backoffBaseMs: 30_000,
      ...opts,
    };
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.halted = false;
    this.abort = new AbortController();
    this.schedule(0);
  }

  /** Ask for an immediate pass, e.g. right after a transaction that enqueued mail committed. */
  wake() {
    if (this.stopped) return;
    if (this.running) {
      this.wakeRequested = true;
      return;
    }
    this.schedule(0);
  }

  async stop() {
    this.stopped = true;
    this.halted = true;
    clearTimeout(this.timer);
    this.abort.abort();
    await this.running?.catch(() => {});
  }

  private schedule(ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref();
  }

  private async tick() {
    if (this.stopped || this.running) return;
    this.running = this.drain()
      .then(() => undefined)
      .catch((err) => this.log.warn({ err }, 'email outbox pass failed'))
      .finally(() => {
        this.running = undefined;
        if (this.stopped) return;
        const again = this.wakeRequested;
        this.wakeRequested = false;
        this.schedule(again ? 0 : this.o.pollIntervalMs);
      });
    await this.running;
  }

  /** Process batches until nothing is due. Exposed for tests and for one-off runs. */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.runOnce();
      total += n;
      if (n < this.o.batchSize || this.halted) return total;
    }
  }

  /** Claim and send one batch. Returns how many rows were claimed. */
  async runOnce(): Promise<number> {
    const now = new Date();
    const lockedUntil = new Date(now.getTime() + this.o.lockMs);
    // Claim due pending rows, and rows a crashed worker left in 'sending' past their lock.
    // SKIP LOCKED lets concurrent workers on other instances take different rows.
    const claimed = await sql<{ id: string; template: string; to_address: string; subject: string; html: string; text_body: string; attempts: number }>`
      update email_outbox set status = 'sending', locked_until = ${lockedUntil}, attempts = attempts + 1
      where id in (
        select id from email_outbox
        where (status = 'pending' and next_attempt_at <= ${now})
           or (status = 'sending' and locked_until < ${now})
        order by next_attempt_at
        limit ${this.o.batchSize}
        for update skip locked
      )
      returning id, template, to_address, subject, html, text_body, attempts`.execute(this.db);

    for (const row of claimed.rows) {
      if (this.halted) break; // unfinished rows are recovered after their lock expires
      await this.deliver(row);
    }
    return claimed.rows.length;
  }

  private async deliver(row: { id: string; template: string; to_address: string; subject: string; html: string; text_body: string; attempts: number }) {
    try {
      const res = await this.provider.send(
        {
          to: row.to_address,
          from: this.o.from,
          replyTo: this.o.replyTo,
          subject: row.subject,
          html: row.html,
          text: row.text_body,
          idempotencyKey: row.id,
          tag: row.template,
        },
        this.abort.signal,
      );
      await this.db
        .updateTable('email_outbox')
        .set({
          status: 'sent',
          sent_at: new Date(),
          provider: this.provider.name,
          provider_message_id: res.providerMessageId,
          locked_until: null,
          last_error: null,
          subject: null,
          html: null,
          text_body: null,
        })
        .where('id', '=', row.id)
        .execute();
      this.metrics?.onResult('sent', row.template);
      this.log.info({ emailId: row.id, template: row.template, providerMessageId: res.providerMessageId }, 'email sent');
    } catch (err) {
      const retryable = err instanceof EmailSendError ? err.retryable : true;
      const message = (err as Error).message.slice(0, 300);
      if (retryable && row.attempts < this.o.maxAttempts) {
        // Exponential backoff with full jitter: 30s, 1m, 2m, ... capped at 1h.
        const ceiling = Math.min(this.o.backoffBaseMs * 2 ** (row.attempts - 1), 3_600_000);
        const next = new Date(Date.now() + Math.floor(ceiling / 2 + Math.random() * (ceiling / 2)));
        await this.db
          .updateTable('email_outbox')
          .set({ status: 'pending', next_attempt_at: next, locked_until: null, last_error: message })
          .where('id', '=', row.id)
          .execute();
        this.metrics?.onResult('retry', row.template);
        this.log.warn({ emailId: row.id, template: row.template, attempt: row.attempts, error: message }, 'email send failed, will retry');
      } else {
        await this.db
          .updateTable('email_outbox')
          .set({ status: 'failed', locked_until: null, last_error: message, provider: this.provider.name, subject: null, html: null, text_body: null })
          .where('id', '=', row.id)
          .execute();
        this.metrics?.onResult('failed', row.template);
        this.log.error({ emailId: row.id, template: row.template, attempt: row.attempts, error: message }, 'email permanently failed');
      }
    }
  }
}

/** Delete terminal rows after the retention window. Addresses are personal data. */
export async function pruneEmailOutbox(db: DB, retentionDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const res = await db
    .deleteFrom('email_outbox')
    .where('status', 'in', ['sent', 'failed'])
    .where('created_at', '<', cutoff)
    .executeTakeFirst();
  return Number(res.numDeletedRows);
}
