// Realtime (WebSocket) protocol. Zod-free so the web client can import it
// without pulling a validator into its bundle; the API validates client frames.

export const REALTIME_PROTOCOL_VERSION = 1;
export const REALTIME_PATH = '/v1/realtime';

/** WebSocket close codes. 4xxx are application codes; clients branch on them. */
export const REALTIME_CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  /** Server is restarting or draining for a deploy: reconnect (with jitter) to another instance. */
  SERVICE_RESTART: 1012,
  /** Server is at capacity: reconnect later with backoff. */
  TRY_AGAIN_LATER: 1013,
  UNAUTHENTICATED: 4001,
  PROTOCOL_ERROR: 4002,
  /** The session behind this socket was signed out or revoked: do not reconnect. */
  SESSION_REVOKED: 4003,
  RATE_LIMITED: 4008,
  TOO_MANY_CONNECTIONS: 4009,
} as const;

/** Close codes after which a client must not reconnect with the same credentials. */
export const REALTIME_TERMINAL_CLOSE_CODES: readonly number[] = [REALTIME_CLOSE.UNAUTHENTICATED, REALTIME_CLOSE.SESSION_REVOKED];

/** Events in a user's ordered stream. Payloads are small notifications, not documents. */
export type RealtimeEventType = 'me.updated' | 'email.verified' | 'session.revoked';

export interface PresenceState {
  id: string;
  online: boolean;
  /** ISO time the user was last connected; null when unknown or hidden by their privacy settings. */
  lastSeenAt: string | null;
}

export type ClientFrame =
  /** Deliver every event after `after` (the last seq this client processed), then live events. */
  | { t: 'resume'; after: number }
  | { t: 'ping'; n?: number }
  | { t: 'presence.sub'; ids: string[] }
  | { t: 'presence.unsub'; ids: string[] };

export type ServerFrame =
  | { t: 'hello'; v: number; seq: number; heartbeatMs: number; region: string }
  | { t: 'event'; seq: number; type: RealtimeEventType; payload: Record<string, unknown>; at: string }
  /** The client's cursor is too old or invalid: refetch state over HTTP and continue from `seq`. */
  | { t: 'resync'; seq: number }
  | { t: 'pong'; n?: number }
  | { t: 'presence'; users: PresenceState[] }
  | { t: 'error'; code: 'protocol_error' | 'rate_limited' | 'too_many_ids' };

export const PRESENCE_SUB_MAX = 100;
