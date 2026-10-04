import { Counter, Gauge, type Registry } from 'prom-client';
import type { WebSocket } from 'ws';
import {
  PRESENCE_SUB_MAX,
  REALTIME_CLOSE,
  REALTIME_PROTOCOL_VERSION,
  type RealtimeEventType,
  type ServerFrame,
} from '@chatme/contracts/realtime';
import type { DB } from '../../db/database.js';
import type { Bus, BusMessage } from './bus.js';
import { currentSeq, replay } from './events.js';
import type { Presence } from './presence.js';

/**
 * WebSocket gateway: owns this instance's sockets.
 *
 * Delivery is at-least-once and ordered per user. Each socket tracks the last
 * seq it delivered; live events arriving out of order or after a bus outage
 * trigger a catch-up read from user_events, and a client reconnecting with
 * its cursor gets everything it missed (or a `resync` when the gap is too
 * large). Clients drop any seq they have already processed.
 */
export interface GatewayOptions {
  instanceId: string;
  region: string;
  heartbeatMs?: number;
  maxConnections?: number;
  maxPerUser?: number;
  revalidateMs?: number;
  /** Token bucket for client frames: sustained rate per second and burst size. */
  frameRate?: number;
  frameBurst?: number;
  resumeTimeoutMs?: number;
}

export interface ConnAuth {
  userId: string;
  sessionId: string;
  deviceId: string;
}

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; debug: (o: object, m: string) => void };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUEUED = 100;

interface Conn {
  ws: WebSocket;
  auth: ConnAuth;
  /** Last seq delivered; null until the client resumed (or the resume timeout passed). */
  cursor: number | null;
  helloSeq: number;
  queue: { seq: number; ev?: { type: string; payload: Record<string, unknown>; at: string } }[];
  overflowed: boolean;
  chain: Promise<void>;
  watching: Set<string>;
  alive: boolean;
  tokens: number;
  lastRefill: number;
  resumeTimer?: NodeJS.Timeout;
  /** Cursor from the client's resume frame, which may arrive before setup finishes. */
  resumeAfter: number | null;
  ready: boolean;
  closed: boolean;
}

export class RealtimeGateway {
  private readonly conns = new Set<Conn>();
  private readonly byUser = new Map<string, Set<Conn>>();
  private readonly watchers = new Map<string, Set<Conn>>();
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private revalidateTimer: NodeJS.Timeout | undefined;
  private draining = false;
  private readonly o: Required<GatewayOptions>;
  private readonly m: { connections: Gauge; frames: Counter<'direction'>; closes: Counter<'code'>; delivered: Counter<'path'> } | undefined;

  constructor(
    private readonly db: DB,
    private readonly bus: Bus,
    private readonly presence: Presence,
    private readonly log: Log,
    opts: GatewayOptions,
    registry?: Registry,
  ) {
    this.o = {
      heartbeatMs: 25_000,
      maxConnections: 5_000,
      maxPerUser: 10,
      revalidateMs: 5 * 60_000,
      frameRate: 10,
      frameBurst: 20,
      resumeTimeoutMs: 10_000,
      ...opts,
    };
    if (registry) {
      const conns = this.conns;
      this.m = {
        connections: new Gauge({ name: 'chatme_realtime_connections', help: 'Open WebSocket connections on this instance', registers: [registry], collect() { this.set(conns.size); } }),
        frames: new Counter({ name: 'chatme_realtime_frames_total', help: 'WebSocket frames', labelNames: ['direction'] as const, registers: [registry] }),
        closes: new Counter({ name: 'chatme_realtime_closes_total', help: 'WebSocket closes by code', labelNames: ['code'] as const, registers: [registry] }),
        delivered: new Counter({ name: 'chatme_realtime_events_delivered_total', help: 'User events delivered, by path (live, catchup, resume)', labelNames: ['path'] as const, registers: [registry] }),
      };
      const bus = this.bus;
      new Gauge({ name: 'chatme_realtime_bus_connected', help: '1 when the cross-instance bus is connected', registers: [registry], collect() { this.set(bus.connected ? 1 : 0); } });
    }
  }

  get size() {
    return this.conns.size;
  }

  get isDraining() {
    return this.draining;
  }

  start() {
    this.bus.subscribe((msg) => this.onBus(msg));
    // After a bus outage, notifications may have been lost: catch every socket up from the log.
    this.bus.onReconnect(() => {
      for (const c of this.conns) this.enqueue(c, () => this.catchUp(c, null, 'catchup'));
    });
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.o.heartbeatMs);
    this.heartbeatTimer.unref();
    this.revalidateTimer = setInterval(() => void this.revalidate().catch((err) => this.log.warn({ err }, 'realtime revalidate failed')), this.o.revalidateMs);
    this.revalidateTimer.unref();
  }

  /** Handle a freshly upgraded socket. `auth` is null when the upgrade carried no valid session. */
  async accept(ws: WebSocket, auth: ConnAuth | null): Promise<void> {
    if (!auth) return this.reject(ws, REALTIME_CLOSE.UNAUTHENTICATED, 'unauthenticated');
    if (this.draining) return this.reject(ws, REALTIME_CLOSE.SERVICE_RESTART, 'draining');
    if (this.conns.size >= this.o.maxConnections) return this.reject(ws, REALTIME_CLOSE.TRY_AGAIN_LATER, 'capacity');

    const conn: Conn = {
      ws, auth, cursor: null, helloSeq: 0, queue: [], overflowed: false, chain: Promise.resolve(),
      watching: new Set(), alive: true, tokens: this.o.frameBurst, lastRefill: Date.now(), resumeAfter: null, ready: false, closed: false,
    };
    // Register before any await so events committed while we set up are queued, not lost.
    this.conns.add(conn);
    let set = this.byUser.get(auth.userId);
    if (!set) this.byUser.set(auth.userId, (set = new Set()));
    set.add(conn);

    ws.on('message', (data, isBinary) => this.onFrame(conn, data as Buffer, isBinary));
    ws.on('pong', () => (conn.alive = true));
    ws.on('close', (code) => void this.onClose(conn, code));
    ws.on('error', (err) => this.log.debug({ err: err.message }, 'websocket error'));

    try {
      if ((await this.presence.connectionCount(auth.userId)) >= this.o.maxPerUser) {
        return this.closeConn(conn, REALTIME_CLOSE.TOO_MANY_CONNECTIONS, 'too many connections');
      }
      await this.presence.connect(auth.userId);
      conn.helloSeq = await currentSeq(this.db, auth.userId);
    } catch (err) {
      this.log.warn({ err }, 'realtime accept failed');
      return this.closeConn(conn, REALTIME_CLOSE.TRY_AGAIN_LATER, 'unavailable');
    }
    if (conn.closed) return;
    this.send(conn, { t: 'hello', v: REALTIME_PROTOCOL_VERSION, seq: conn.helloSeq, heartbeatMs: this.o.heartbeatMs, region: this.o.region });
    conn.ready = true;
    if (conn.resumeAfter !== null) {
      const after = conn.resumeAfter;
      this.enqueue(conn, () => this.resume(conn, after));
      return;
    }
    // A client that never resumes gets live events from the hello point onwards.
    conn.resumeTimer = setTimeout(() => this.enqueue(conn, () => this.resume(conn, conn.helloSeq)), this.o.resumeTimeoutMs);
    conn.resumeTimer.unref();
  }

  private reject(ws: WebSocket, code: number, reason: string) {
    this.m?.closes.inc({ code: String(code) });
    ws.close(code, reason);
  }

  private send(conn: Conn, frame: ServerFrame) {
    if (conn.closed || conn.ws.readyState !== conn.ws.OPEN) return;
    this.m?.frames.inc({ direction: 'out' });
    conn.ws.send(JSON.stringify(frame));
  }

  private closeConn(conn: Conn, code: number, reason: string) {
    if (conn.closed) return;
    this.m?.closes.inc({ code: String(code) });
    conn.ws.close(code, reason);
    // Some clients never complete the closing handshake.
    setTimeout(() => conn.ws.terminate(), 5_000).unref();
  }

  private async onClose(conn: Conn, code: number) {
    if (conn.closed) return;
    conn.closed = true;
    clearTimeout(conn.resumeTimer);
    this.conns.delete(conn);
    const set = this.byUser.get(conn.auth.userId);
    set?.delete(conn);
    if (set && !set.size) this.byUser.delete(conn.auth.userId);
    for (const id of conn.watching) this.unwatch(conn, id);
    if (code === 1006) this.m?.closes.inc({ code: '1006' });
    try {
      await this.presence.disconnect(conn.auth.userId);
    } catch (err) {
      this.log.warn({ err }, 'presence disconnect failed');
    }
  }

  /** Serialize work per socket so events are always sent in seq order. */
  private enqueue(conn: Conn, fn: () => Promise<void>) {
    conn.chain = conn.chain.then(async () => {
      if (conn.closed) return;
      try {
        await fn();
      } catch (err) {
        this.log.warn({ err }, 'realtime delivery failed');
        // The client will catch up from its cursor when it reconnects.
        this.closeConn(conn, REALTIME_CLOSE.TRY_AGAIN_LATER, 'delivery failed');
      }
    });
  }

  private onFrame(conn: Conn, data: Buffer, isBinary: boolean) {
    conn.alive = true;
    this.m?.frames.inc({ direction: 'in' });
    const now = Date.now();
    conn.tokens = Math.min(this.o.frameBurst, conn.tokens + ((now - conn.lastRefill) / 1000) * this.o.frameRate);
    conn.lastRefill = now;
    if (conn.tokens < 1) return this.closeConn(conn, REALTIME_CLOSE.RATE_LIMITED, 'rate limited');
    conn.tokens -= 1;
    if (isBinary) return this.closeConn(conn, REALTIME_CLOSE.PROTOCOL_ERROR, 'text frames only');

    let frame: { t?: unknown; after?: unknown; n?: unknown; ids?: unknown };
    try {
      frame = JSON.parse(data.toString('utf8'));
    } catch {
      return this.closeConn(conn, REALTIME_CLOSE.PROTOCOL_ERROR, 'invalid json');
    }
    if (typeof frame !== 'object' || frame === null) return this.closeConn(conn, REALTIME_CLOSE.PROTOCOL_ERROR, 'invalid frame');

    switch (frame.t) {
      case 'ping':
        return this.send(conn, { t: 'pong', ...(typeof frame.n === 'number' ? { n: frame.n } : {}) });
      case 'resume': {
        const after = frame.after;
        if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) {
          return this.closeConn(conn, REALTIME_CLOSE.PROTOCOL_ERROR, 'invalid cursor');
        }
        if (conn.cursor !== null || conn.resumeAfter !== null) return; // only the first resume counts
        conn.resumeAfter = after;
        if (!conn.ready) return; // accept() picks it up once setup finishes
        clearTimeout(conn.resumeTimer);
        return this.enqueue(conn, () => this.resume(conn, after));
      }
      case 'presence.sub':
      case 'presence.unsub': {
        const ids = frame.ids;
        if (!Array.isArray(ids) || ids.length > PRESENCE_SUB_MAX || !ids.every((i) => typeof i === 'string' && UUID.test(i))) {
          return this.send(conn, { t: 'error', code: 'too_many_ids' });
        }
        const unique = [...new Set(ids.map((i) => i.toLowerCase()))];
        if (frame.t === 'presence.unsub') {
          for (const id of unique) this.unwatch(conn, id);
          return;
        }
        const fresh = unique.filter((id) => !conn.watching.has(id));
        if (conn.watching.size + fresh.length > PRESENCE_SUB_MAX) return this.send(conn, { t: 'error', code: 'too_many_ids' });
        for (const id of fresh) this.watch(conn, id);
        return this.enqueue(conn, async () => this.send(conn, { t: 'presence', users: await this.presence.status(unique) }));
      }
      default:
        return this.closeConn(conn, REALTIME_CLOSE.PROTOCOL_ERROR, 'unknown frame');
    }
  }

  private watch(conn: Conn, id: string) {
    conn.watching.add(id);
    let set = this.watchers.get(id);
    if (!set) this.watchers.set(id, (set = new Set()));
    set.add(conn);
  }

  private unwatch(conn: Conn, id: string) {
    conn.watching.delete(id);
    const set = this.watchers.get(id);
    set?.delete(conn);
    if (set && !set.size) this.watchers.delete(id);
  }

  private async resume(conn: Conn, after: number) {
    if (conn.cursor !== null) return;
    const upTo = await currentSeq(this.db, conn.auth.userId);
    const events = await replay(this.db, conn.auth.userId, after, upTo);
    if (events === null) {
      this.send(conn, { t: 'resync', seq: upTo });
    } else {
      for (const e of events) this.sendEvent(conn, e.seq, e.type, e.payload, e.at, 'resume');
    }
    conn.cursor = upTo;
    const queued = conn.queue;
    const overflowed = conn.overflowed;
    conn.queue = [];
    conn.overflowed = false;
    if (overflowed) return this.catchUp(conn, null, 'catchup');
    for (const q of queued) await this.deliver(conn, q.seq, q.ev);
  }

  private sendEvent(conn: Conn, seq: number, type: string, payload: Record<string, unknown>, at: string, path: 'live' | 'catchup' | 'resume') {
    this.send(conn, { t: 'event', seq, type: type as RealtimeEventType, payload, at });
    this.m?.delivered.inc({ path });
  }

  private async deliver(conn: Conn, seq: number, ev?: Conn['queue'][number]['ev']) {
    if (conn.cursor === null) {
      if (conn.queue.length >= MAX_QUEUED) conn.overflowed = true;
      else conn.queue.push({ seq, ev });
      return;
    }
    if (seq <= conn.cursor) return;
    if (seq === conn.cursor + 1 && ev) {
      this.sendEvent(conn, seq, ev.type, ev.payload, ev.at, 'live');
      conn.cursor = seq;
      return;
    }
    await this.catchUp(conn, seq, 'catchup');
  }

  /** Read missed events from the log up to `upTo` (or the current seq) and send them. */
  private async catchUp(conn: Conn, upTo: number | null, path: 'catchup') {
    if (conn.cursor === null) return;
    const target = upTo ?? (await currentSeq(this.db, conn.auth.userId));
    if (target <= conn.cursor) return;
    const events = await replay(this.db, conn.auth.userId, conn.cursor, target);
    if (events === null) this.send(conn, { t: 'resync', seq: target });
    else for (const e of events) this.sendEvent(conn, e.seq, e.type, e.payload, e.at, path);
    conn.cursor = target;
  }

  private onBus(msg: BusMessage) {
    switch (msg.k) {
      case 'ev': {
        const set = this.byUser.get(msg.u);
        if (!set) return;
        for (const c of set) this.enqueue(c, () => this.deliver(c, msg.s, msg.ev));
        return;
      }
      case 'rv': {
        const set = this.byUser.get(msg.u);
        if (!set) return;
        for (const c of [...set]) {
          if (msg.all || msg.sids?.includes(c.auth.sessionId)) this.closeConn(c, REALTIME_CLOSE.SESSION_REVOKED, 'session revoked');
        }
        return;
      }
      case 'pr': {
        const set = this.watchers.get(msg.u);
        if (!set) return;
        for (const c of set) this.send(c, { t: 'presence', users: [{ id: msg.u, online: msg.on, lastSeenAt: msg.at }] });
        return;
      }
    }
  }

  private heartbeat() {
    for (const c of this.conns) {
      if (!c.alive) {
        // No pong or frame for a whole interval: the peer is gone (phone lost signal, NAT dropped us).
        this.m?.closes.inc({ code: 'heartbeat_timeout' });
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }

  /**
   * Close sockets whose session no longer exists or expired, and count socket
   * activity as session activity so WebSocket-only clients are not idled out.
   */
  async revalidate(): Promise<void> {
    if (!this.conns.size) return;
    const ids = [...new Set([...this.conns].map((c) => c.auth.sessionId))];
    const live = new Set<string>();
    for (let i = 0; i < ids.length; i += 500) {
      const rows = await this.db
        .updateTable('sessions')
        .set({ last_seen_at: new Date() })
        .where('id', 'in', ids.slice(i, i + 500))
        .where('expires_at', '>', new Date())
        .returning('id')
        .execute();
      for (const r of rows) live.add(r.id);
    }
    for (const c of [...this.conns]) {
      if (!live.has(c.auth.sessionId)) this.closeConn(c, REALTIME_CLOSE.SESSION_REVOKED, 'session ended');
    }
  }

  /**
   * Graceful drain for deploys and scale-in: refuse new sockets, then close the
   * existing ones with 1012 spread over `spreadMs` so clients reconnect to other
   * instances gradually instead of all at once.
   */
  async drain(spreadMs = 5_000, timeoutMs = 10_000): Promise<void> {
    this.draining = true;
    clearInterval(this.heartbeatTimer);
    clearInterval(this.revalidateTimer);
    const all = [...this.conns];
    const step = all.length > 1 ? spreadMs / all.length : 0;
    all.forEach((c, i) => {
      setTimeout(() => this.closeConn(c, REALTIME_CLOSE.SERVICE_RESTART, 'server restarting'), Math.floor(i * step)).unref();
    });
    const deadline = Date.now() + spreadMs + timeoutMs;
    while (this.conns.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    for (const c of this.conns) c.ws.terminate();
    await Promise.allSettled([...all].map((c) => c.chain));
  }

  stop() {
    clearInterval(this.heartbeatTimer);
    clearInterval(this.revalidateTimer);
  }
}
