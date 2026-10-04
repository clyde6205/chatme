import pg from 'pg';
import { sql } from 'kysely';
import type { DB } from '../../db/database.js';

/**
 * Cross-instance message bus for realtime fan-out.
 *
 * Every API instance subscribes; a publish reaches all of them, including the
 * publisher. Messages are small signals (ids, flags); durable data lives in
 * PostgreSQL. The Postgres implementation uses LISTEN/NOTIFY, so scaling to
 * several instances needs no extra infrastructure. A Redis, NATS or managed
 * pub/sub adapter can replace it behind this interface when traffic outgrows it.
 */
export type BusMessage =
  /** A user event committed. `ev` is inlined when it fits in a notification. */
  | { k: 'ev'; u: string; s: number; ev?: { type: string; payload: Record<string, unknown>; at: string } }
  /** Sessions were revoked; `all` means every session of the user. */
  | { k: 'rv'; u: string; sids?: string[]; all?: boolean }
  /** A user's visible presence changed. */
  | { k: 'pr'; u: string; on: boolean; at: string | null };

export type Executor = Pick<DB, 'executeQuery'> | DB;

export interface Bus {
  /**
   * Publish a message. When `executor` is a transaction, adapters that support
   * it deliver only after commit (Postgres NOTIFY does); others publish immediately.
   */
  publish(msg: BusMessage, executor?: Executor): Promise<void>;
  subscribe(handler: (msg: BusMessage) => void): void;
  /** Called after the bus reconnects; messages may have been missed while it was down. */
  onReconnect(handler: () => void): void;
  readonly connected: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const CHANNEL = 'chatme_bus';
/** PostgreSQL rejects NOTIFY payloads of 8000 bytes or more. */
export const MAX_NOTIFY_BYTES = 7900;

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

export class PostgresBus implements Bus {
  private client: pg.Client | undefined;
  private handlers: ((msg: BusMessage) => void)[] = [];
  private reconnectHandlers: (() => void)[] = [];
  private stopped = true;
  private retry = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private everConnected = false;
  connected = false;

  constructor(
    private readonly db: DB,
    private readonly opts: { url: string; ssl?: pg.ClientConfig['ssl']; log: Log; onConnectedChange?: (c: boolean) => void },
  ) {}

  async publish(msg: BusMessage, executor: Executor = this.db): Promise<void> {
    let payload = JSON.stringify(msg);
    if (Buffer.byteLength(payload) > MAX_NOTIFY_BYTES && msg.k === 'ev') {
      // Receivers fetch the event from user_events instead.
      payload = JSON.stringify({ k: 'ev', u: msg.u, s: msg.s });
    }
    if (Buffer.byteLength(payload) > MAX_NOTIFY_BYTES) throw new Error('bus message too large');
    await sql`select pg_notify(${CHANNEL}, ${payload})`.execute(executor as DB);
  }

  subscribe(handler: (msg: BusMessage) => void) {
    this.handlers.push(handler);
  }

  onReconnect(handler: () => void) {
    this.reconnectHandlers.push(handler);
  }

  async start() {
    this.stopped = false;
    await this.connect();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    const c = this.client;
    this.client = undefined;
    this.setConnected(false);
    await c?.end().catch(() => {});
  }

  private setConnected(v: boolean) {
    if (this.connected === v) return;
    this.connected = v;
    this.opts.onConnectedChange?.(v);
  }

  private async connect() {
    if (this.stopped) return;
    const client = new pg.Client({
      connectionString: this.opts.url,
      ssl: this.opts.ssl,
      application_name: 'chatme-realtime-bus',
      connectionTimeoutMillis: 5_000,
      // Detect half-open TCP connections (NAT timeouts, failovers) instead of waiting forever.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
    client.on('notification', (n) => {
      if (n.channel !== CHANNEL || !n.payload) return;
      let msg: BusMessage;
      try {
        msg = JSON.parse(n.payload) as BusMessage;
      } catch {
        return;
      }
      for (const h of this.handlers) {
        try {
          h(msg);
        } catch (err) {
          this.opts.log.warn({ err }, 'bus handler failed');
        }
      }
    });
    const onDown = (err?: Error) => {
      if (this.client !== client) return;
      this.client = undefined;
      this.setConnected(false);
      client.end().catch(() => {});
      if (!this.stopped) {
        this.opts.log.warn({ err: err?.message }, 'realtime bus disconnected; reconnecting');
        this.scheduleReconnect();
      }
    };
    client.on('error', onDown);
    client.on('end', () => onDown());
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
    } catch (err) {
      client.removeAllListeners('end');
      await client.end().catch(() => {});
      this.opts.log.warn({ err: (err as Error).message }, 'realtime bus connect failed');
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) {
      await client.end().catch(() => {});
      return;
    }
    this.client = client;
    this.retry = 0;
    this.setConnected(true);
    if (this.everConnected) for (const h of this.reconnectHandlers) h();
    else this.opts.log.info({}, 'realtime bus connected');
    this.everConnected = true;
  }

  private scheduleReconnect() {
    clearTimeout(this.retryTimer);
    // Full jitter, 0.5s to 30s.
    const ceiling = Math.min(500 * 2 ** this.retry++, 30_000);
    this.retryTimer = setTimeout(() => void this.connect(), Math.random() * ceiling);
    this.retryTimer.unref();
  }

  /** Test hook: drop the LISTEN connection as a network failure would. */
  simulateDisconnect() {
    this.client?.emit('error', new Error('simulated disconnect'));
  }
}

/** Single-process bus for unit tests and tools; delivers synchronously after publish. */
export class MemoryBus implements Bus {
  private handlers: ((msg: BusMessage) => void)[] = [];
  connected = false;
  async publish(msg: BusMessage) {
    for (const h of this.handlers) h(structuredClone(msg));
  }
  subscribe(handler: (msg: BusMessage) => void) {
    this.handlers.push(handler);
  }
  onReconnect() {}
  async start() {
    this.connected = true;
  }
  async stop() {
    this.connected = false;
  }
}
