import { EmailSendError, type EmailMessage, type EmailProvider, type SendResult } from './provider.js';

/**
 * Resend adapter (https://resend.com/docs/api-reference/emails/send-email).
 * Plain fetch, no SDK: one endpoint, fewer dependencies, and the base URL is
 * configurable so tests can point it at a local mock server.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';
  constructor(
    private readonly opts: { apiKey: string; baseUrl: string; timeoutMs?: number },
  ) {}

  async send(m: EmailMessage, signal?: AbortSignal): Promise<SendResult> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 10_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/emails`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          'content-type': 'application/json',
          // Resend de-duplicates requests with the same key for 24 hours, so a retry after
          // a timeout where the first request actually succeeded does not send twice.
          'idempotency-key': m.idempotencyKey,
          'user-agent': 'chatme-api',
        },
        body: JSON.stringify({
          from: m.from,
          to: [m.to],
          subject: m.subject,
          html: m.html,
          text: m.text,
          ...(m.replyTo ? { reply_to: m.replyTo } : {}),
          ...(m.tag ? { tags: [{ name: 'template', value: m.tag.replace(/[^A-Za-z0-9_-]/g, '_') }] } : {}),
        }),
        signal: combined,
      });
    } catch (err) {
      // DNS failure, connection reset, timeout: all worth retrying.
      throw new EmailSendError(`resend request failed: ${(err as Error).name}`, true);
    }

    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { id?: unknown };
      return { providerMessageId: typeof body.id === 'string' ? body.id : null };
    }
    // Error bodies carry a short machine-readable name; never echo our request back into logs.
    const detail = await res
      .json()
      .then((b) => [(b as { name?: unknown }).name, (b as { message?: unknown }).message].filter((x) => typeof x === 'string').join(': ').slice(0, 200))
      .catch(() => '');
    const retryable = res.status === 429 || res.status >= 500 || res.status === 408 || res.status === 409;
    throw new EmailSendError(`resend ${res.status}${detail ? ` ${detail}` : ''}`, retryable, res.status);
  }
}
