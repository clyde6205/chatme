# Realtime (WebSockets)

`GET /v1/realtime` upgrades to a WebSocket. Protocol types live in `packages/contracts/src/realtime.ts` (zod-free, shared by API and clients).

## What it carries today

Phase 1 has no messaging yet, so realtime carries what exists: a per-user ordered event stream (`me.updated`, `email.verified`, `session.revoked`), presence, and immediate closing of sockets whose session was revoked. Messaging in Phase 2 adds event types to the same stream; the transport, ordering, resume and fan-out below do not change.

## Authentication

- Browser: the session cookie travels with the handshake (web and API are same-site: `chatme.pro` and `api.chatme.pro`). Cookie-authenticated upgrades must come from an origin in `WEB_ORIGINS`, otherwise the handshake gets HTTP 403 (cross-site WebSocket hijacking defence).
- Native: `Authorization: Bearer <token>` on the handshake.
- No or invalid session: the socket opens and closes immediately with `4001`, because browsers cannot read the HTTP status of a failed handshake.
- Sockets are re-checked every 5 minutes against `sessions` (which also counts as session activity) and closed with `4003` as soon as any instance revokes the session (logout, revoke, password change or reset, account deletion).

## Delivery: ordered, at-least-once, resumable

- Every user has a sequence counter (`user_event_seq`). `publishUserEvent` bumps it inside the transaction that made the change, which locks the counter row until commit, so for one user commit order equals seq order. A client cursor can therefore never skip an event that commits late.
- The event row goes to `user_events` (kept 7 days) and a `NOTIFY` goes out. NOTIFY is transactional: nothing is announced for a change that rolled back.
- On connect the server sends `hello {seq}`; the client sends `resume {after}` with the last seq it processed (persisted per user in `localStorage`). The server replays the gap, then streams live events. Gaps over 500 events, pruned events, or a cursor ahead of the server get `resync`, and the client refetches state over HTTP.
- Live events that arrive out of order, or after the instance's bus connection was down, trigger a catch-up read from `user_events`. Clients drop any seq they already processed.

## Horizontal scaling across instances

```
client ──ws──> instance A ─┐                 ┌─> instance B ──ws──> other device
                            ├─ PostgreSQL ────┤
          HTTP write ──────>┘  NOTIFY chatme_bus (on commit)
```

- `Bus` (`modules/realtime/bus.ts`) is an interface. `PostgresBus` holds one dedicated `LISTEN` connection per instance with TCP keepalive, reconnects with jittered backoff, and on reconnect makes the gateway catch every socket up from the log. NOTIFY payloads are small signals (under 8 KB; larger events are fetched by id).
- LISTEN needs a session-mode connection. Supabase's transaction pooler (port 6543) cannot hold it: set `REALTIME_DATABASE_URL` to the direct or session-pooler endpoint.
- When NOTIFY throughput becomes a bottleneck, a Redis, NATS or managed pub/sub adapter implements the same interface; nothing else changes.

## Presence

- Each instance registers in `realtime_instances` and heart-beats every 15 s. `realtime_presence` holds (instance, user, connection count).
- A user is online if any of their rows belongs to an instance with a fresh heartbeat (45 s). Survivors sweep dead instances and announce their users offline, so a crashed machine does not leave people "online" forever.
- Offline is announced after a 10 s grace period; a reconnect within it, on any instance, is invisible to watchers.
- `presence.sub {ids}` (up to 100 ids per socket) returns current state and then pushes changes. Users with `privacy.showPresence = false` always appear offline with no last-seen; unknown ids look the same, so the endpoint cannot be used to probe which ids exist. Turning presence off is announced immediately.

## Limits and failure handling

| Concern | Behaviour |
|---|---|
| Frame size | 4 KiB max (`ws` closes with 1009 before parsing) |
| Frame rate | token bucket, 10/s sustained, burst 20; exceeded → close `4008` |
| Connections per user | 10 across all instances → `4009` |
| Connections per instance | `REALTIME_MAX_CONNECTIONS` (2,500 on Fly; matches `hard_limit`) → `1013` |
| Dead peers | ping every 25 s; no pong for a full interval → terminated |
| Compression | off (`perMessageDeflate: false`) to save CPU and memory on small machines and phones |
| Handshake floods | the global per-IP HTTP rate limit applies to upgrades |

## Graceful shutdown (deploys, scale-in)

On SIGTERM: `/health/ready` returns 503 `draining` (Fly stops routing new connections), new sockets are refused with `1012`, existing sockets are closed with `1012` spread over 5 s so clients reconnect to other machines gradually, then HTTP drains, workers stop, the instance removes its presence rows and announces users not connected elsewhere. `kill_timeout` is 30 s; the server forces exit at 25 s.

## Web client (`apps/web/src/lib/realtime.ts`)

Loaded 1.5 s after first render in its own chunk, so it costs nothing on the startup path. Full-jitter backoff 1 s to 30 s (reset after a stable minute, extra backoff on `4008`/`4009`/`1013`), pauses while offline and reconnects on the `online` event, disconnects after 60 s in the background and reconnects on return, app-level pings to detect dead connections, and never reconnects after `4001`/`4003` (the app signs out instead).

## Metrics

`chatme_realtime_connections`, `chatme_realtime_frames_total{direction}`, `chatme_realtime_closes_total{code}`, `chatme_realtime_events_delivered_total{path}`, `chatme_realtime_bus_connected`.
