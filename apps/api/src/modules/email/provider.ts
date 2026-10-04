/**
 * Transactional email delivery behind a provider-neutral interface.
 * Application code depends only on this file; adapters live beside it.
 */
export interface EmailMessage {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  /** Stable per-message key. Providers that support it use it to make retries idempotent. */
  idempotencyKey: string;
  /** Low-cardinality label for provider dashboards, e.g. the template name. */
  tag?: string;
}

export interface SendResult {
  providerMessageId: string | null;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage, signal?: AbortSignal): Promise<SendResult>;
}

/**
 * A failed send. `retryable` decides whether the outbox tries again
 * (network errors, timeouts, 429, 5xx) or gives up (bad address, auth, 4xx).
 */
export class EmailSendError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
  }
}

/** Development only: logs a summary instead of sending. Refused in production by config. */
export class LogEmailProvider implements EmailProvider {
  readonly name = 'log';
  constructor(private readonly log: (obj: Record<string, unknown>, msg: string) => void) {}
  async send(m: EmailMessage): Promise<SendResult> {
    // The text body is logged so developers can follow verification and reset links locally.
    this.log({ to: m.to, subject: m.subject, text: m.text, tag: m.tag }, 'email (log provider, not sent)');
    return { providerMessageId: null };
  }
}

/** Tests only: records messages and can be told to fail. */
export class MemoryEmailProvider implements EmailProvider {
  readonly name = 'memory';
  readonly sent: EmailMessage[] = [];
  failNext: EmailSendError[] = [];
  async send(m: EmailMessage): Promise<SendResult> {
    const err = this.failNext.shift();
    if (err) throw err;
    this.sent.push(m);
    return { providerMessageId: `mem_${this.sent.length}` };
  }
}
