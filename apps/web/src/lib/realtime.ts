import {
  REALTIME_CLOSE,
  REALTIME_PATH,
  REALTIME_TERMINAL_CLOSE_CODES,
  type ClientFrame,
  type PresenceState,
  type RealtimeEventType,
  type ServerFrame,
} from '@chatme/contracts/realtime';
import { API_BASE } from './api';
import { storage } from './storage';

/**
 * Realtime client, tuned for phones on unreliable networks:
 * - reconnects with full-jitter exponential backoff (1s to 30s), resetting after a stable minute;
 * - pauses while the browser reports offline and reconnects the moment it is back;
 * - disconnects after the app is hidden for a while (saves battery and data), reconnects on return;
 * - detects dead connections with app-level pings, since browsers hide WebSocket ping frames;
 * - resumes from the last processed seq (persisted per user) so nothing is missed or repeated.
 */

export interface RealtimeHandlers {
  onEvent(type: RealtimeEventType, payload: Record<string, unknown>): void;
  /** The cursor could not be served: refetch state over HTTP. */
  onResync(): void;
  /** The session ended (signed out elsewhere, revoked, expired). Do not reconnect. */
  onSessionEnded(): void;
  onPresence?(users: PresenceState[]): void;
  onStatus?(status: RealtimeStatus): void;
}

export type RealtimeStatus = 'connecting' | 'open' | 'waiting' | 'offline' | 'paused' | 'ended';

export interface RealtimeEnv {
  WebSocket: typeof WebSocket;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  random: () => number;
  now: () => number;
  online: () => boolean;
  hidden: () => boolean;
  on(target: 'window' | 'document', event: string, fn: () => void): () => void;
  location: { protocol: string; host: string };
}

const HIDDEN_DISCONNECT_MS = 60_000;
const STABLE_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

export function realtimeUrl(apiBase: string, loc: { protocol: string; host: string }): string {
  if (/^https?:\/\//.test(apiBase)) return apiBase.replace(/^http/, 'ws').replace(/\/$/, '') + REALTIME_PATH;
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${loc.host}${apiBase.replace(/\/$/, '')}${REALTIME_PATH}`;
}

export function browserEnv(): RealtimeEnv {
  return {
    WebSocket,
    setTimeout: setTimeout.bind(window),
    clearTimeout: clearTimeout.bind(window),
    random: Math.random,
    now: Date.now,
    online: () => navigator.onLine !== false,
    hidden: () => document.visibilityState === 'hidden',
    on(target, event, fn) {
      const t = target === 'window' ? window : document;
      t.addEventListener(event, fn);
      return () => t.removeEventListener(event, fn);
    },
    location: window.location,
  };
}

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setTimeout> | undefined;
  private hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatMs = 25_000;
  private lastFrameAt = 0;
  private stopped = false;
  private paused = false;
  private readonly unlisten: (() => void)[] = [];
  private readonly watched = new Set<string>();
  private readonly cursorKey: string;
  private cursor: number;

  constructor(
    private readonly userId: string,
    private readonly handlers: RealtimeHandlers,
    private readonly env: RealtimeEnv = browserEnv(),
    private readonly url = realtimeUrl(API_BASE, env.location),
  ) {
    this.cursorKey = `chatme.rt.cursor.${userId}`;
    this.cursor = storage.get<number>(this.cursorKey) ?? -1;
  }

  start() {
    this.unlisten.push(
      this.env.on('window', 'online', () => this.reconnectNow()),
      this.env.on('window', 'offline', () => this.drop('offline')),
      this.env.on('document', 'visibilitychange', () => this.onVisibility()),
    );
    this.connect();
  }

  stop() {
    this.stopped = true;
    for (const u of this.unlisten.splice(0)) u();
    this.clearTimers();
    this.ws?.close(REALTIME_CLOSE.NORMAL);
    this.ws = null;
  }

  watchPresence(ids: string[]) {
    for (const id of ids) this.watched.add(id);
    this.send({ t: 'presence.sub', ids });
  }

  private status(s: RealtimeStatus) {
    this.handlers.onStatus?.(s);
  }

  private clearTimers() {
    this.env.clearTimeout(this.retryTimer);
    this.env.clearTimeout(this.pingTimer);
    this.env.clearTimeout(this.hiddenTimer);
    this.env.clearTimeout(this.stableTimer);
  }

  private send(frame: ClientFrame) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(frame));
  }

  private connect() {
    if (this.stopped || this.ws) return;
    if (!this.env.online()) return this.status('offline');
    if (this.paused) return this.status('paused');
    this.status('connecting');
    const ws = new this.env.WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.lastFrameAt = this.env.now();
      // Resume immediately; the server accepts it even before its hello.
      if (this.cursor >= 0) this.send({ t: 'resume', after: this.cursor });
    };
    ws.onmessage = (e) => this.onFrame(String(e.data));
    ws.onclose = (e) => this.onClose(ws, e.code);
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private onFrame(raw: string) {
    this.lastFrameAt = this.env.now();
    let f: ServerFrame;
    try {
      f = JSON.parse(raw) as ServerFrame;
    } catch {
      return;
    }
    switch (f.t) {
      case 'hello':
        this.heartbeatMs = f.heartbeatMs;
        this.status('open');
        if (this.cursor < 0) {
          // First connection on this device: start from now; state comes from HTTP.
          this.setCursor(f.seq);
          this.send({ t: 'resume', after: f.seq });
        }
        if (this.watched.size) this.send({ t: 'presence.sub', ids: [...this.watched] });
        this.schedulePing();
        this.env.clearTimeout(this.stableTimer);
        this.stableTimer = this.env.setTimeout(() => (this.attempt = 0), STABLE_MS);
        return;
      case 'event':
        if (f.seq <= this.cursor) return; // already processed (at-least-once delivery)
        this.setCursor(f.seq);
        this.handlers.onEvent(f.type, f.payload);
        return;
      case 'resync':
        this.setCursor(f.seq);
        this.handlers.onResync();
        return;
      case 'presence':
        this.handlers.onPresence?.(f.users);
        return;
      default:
        return;
    }
  }

  private setCursor(seq: number) {
    this.cursor = seq;
    storage.set(this.cursorKey, seq);
  }

  private schedulePing() {
    this.env.clearTimeout(this.pingTimer);
    this.pingTimer = this.env.setTimeout(() => {
      if (!this.ws) return;
      // Nothing heard for two intervals: the connection is dead even if the browser has not noticed.
      if (this.env.now() - this.lastFrameAt > this.heartbeatMs * 2) {
        this.drop('waiting');
        this.scheduleRetry();
        return;
      }
      this.send({ t: 'ping' });
      this.schedulePing();
    }, this.heartbeatMs);
  }

  private onClose(ws: WebSocket, code: number) {
    if (this.ws !== ws) return;
    this.ws = null;
    this.env.clearTimeout(this.pingTimer);
    this.env.clearTimeout(this.stableTimer);
    if (this.stopped) return;
    if (REALTIME_TERMINAL_CLOSE_CODES.includes(code)) {
      this.stopped = true;
      this.status('ended');
      this.handlers.onSessionEnded();
      return;
    }
    // Rate limited or full: back off harder.
    if (code === REALTIME_CLOSE.RATE_LIMITED || code === REALTIME_CLOSE.TOO_MANY_CONNECTIONS || code === REALTIME_CLOSE.TRY_AGAIN_LATER) this.attempt += 2;
    this.scheduleRetry();
  }

  /** Close the socket without treating it as an error (offline, hidden, dead). */
  private drop(status: RealtimeStatus) {
    const ws = this.ws;
    this.ws = null;
    this.env.clearTimeout(this.pingTimer);
    this.env.clearTimeout(this.retryTimer);
    if (ws) {
      ws.onclose = null;
      ws.close(REALTIME_CLOSE.NORMAL);
    }
    this.status(status);
  }

  private scheduleRetry() {
    if (this.stopped) return;
    this.status('waiting');
    const ceiling = Math.min(1000 * 2 ** this.attempt, MAX_BACKOFF_MS);
    this.attempt = Math.min(this.attempt + 1, 10);
    // Full jitter spreads reconnects after a server restart instead of a synchronized stampede.
    this.env.clearTimeout(this.retryTimer);
    this.retryTimer = this.env.setTimeout(() => this.connect(), Math.max(250, this.env.random() * ceiling));
  }

  private reconnectNow() {
    if (this.stopped || this.ws) return;
    this.attempt = 0;
    this.env.clearTimeout(this.retryTimer);
    this.connect();
  }

  private onVisibility() {
    if (this.env.hidden()) {
      this.env.clearTimeout(this.hiddenTimer);
      this.hiddenTimer = this.env.setTimeout(() => {
        this.paused = true;
        this.drop('paused');
      }, HIDDEN_DISCONNECT_MS);
    } else {
      this.env.clearTimeout(this.hiddenTimer);
      if (this.paused) {
        this.paused = false;
        this.reconnectNow();
      }
    }
  }
}
