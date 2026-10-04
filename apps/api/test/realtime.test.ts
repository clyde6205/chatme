import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { REALTIME_CLOSE, type ServerFrame } from '@chatme/contracts/realtime';
import { PostgresBus } from '../src/modules/realtime/bus.js';
import { replay } from '../src/modules/realtime/events.js';
import { browserHeaders, createTestApp, registerNative, resetDb, type TestApp } from './helpers.js';

/**
 * Two API instances in one process, each with its own HTTP server, WebSocket
 * gateway and LISTEN connection, sharing the test database: the same topology
 * as two Fly Machines behind the proxy.
 */
let a: TestApp;
let b: TestApp;
let urlA: string;
let urlB: string;

const fast = { gateway: { heartbeatMs: 300, resumeTimeoutMs: 300 }, presence: { heartbeatMs: 200, staleMs: 800, graceMs: 200 } };

async function start(id: string) {
  const t = await createTestApp({ FLY_MACHINE_ID: id, FLY_REGION: id === 'inst-a' ? 'iad' : 'fra' }, undefined, fast);
  await t.app.runtime.start({ workers: false });
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  return { t, url: `ws://127.0.0.1:${(t.app.server.address() as AddressInfo).port}/v1/realtime` };
}

beforeAll(async () => {
  ({ t: a, url: urlA } = await start('inst-a'));
  ({ t: b, url: urlB } = await start('inst-b'));
});
afterAll(async () => {
  await a.close();
  await b.close();
});

interface Client {
  ws: WebSocket;
  frames: ServerFrame[];
  next<T extends ServerFrame['t']>(t: T, pred?: (f: Extract<ServerFrame, { t: T }>) => boolean, timeoutMs?: number): Promise<Extract<ServerFrame, { t: T }>>;
  closed: Promise<{ code: number; reason: string }>;
  send(frame: unknown): void;
}
const clients: Client[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.ws.terminate();
});
beforeEach(async () => {
  // Presence rows reference instances, so keep the instance rows while clearing users.
  await resetDb(a).catch(() => {});
  await a.db.insertInto('realtime_instances').values([{ id: 'inst-a', region: 'iad' }, { id: 'inst-b', region: 'fra' }]).onConflict((oc) => oc.doNothing()).execute();
});

function connect(url: string, headers: Record<string, string>): Client {
  const ws = new WebSocket(url, { headers });
  const frames: ServerFrame[] = [];
  const waiters: (() => void)[] = [];
  ws.on('message', (d) => {
    frames.push(JSON.parse(d.toString()));
    for (const w of waiters.splice(0)) w();
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  ws.on('error', () => {});
  const client: Client = {
    ws,
    frames,
    closed,
    send: (f) => ws.send(JSON.stringify(f)),
    next(t, pred, timeoutMs = 3000) {
      return new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`timed out waiting for ${t}; got ${JSON.stringify(frames)}`)), timeoutMs);
        const check = () => {
          const i = frames.findIndex((f) => f.t === t && (!pred || pred(f as never)));
          if (i >= 0) {
            clearTimeout(deadline);
            resolve(frames.splice(i, 1)[0] as never);
          } else waiters.push(check);
        };
        check();
      });
    },
  };
  clients.push(client);
  return client;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const patchProfile = (t: TestApp, auth: Record<string, string>, displayName: string) =>
  t.app.inject({ method: 'PATCH', url: '/v1/me/profile', headers: auth, payload: { displayName } });

describe('realtime connection', () => {
  it('rejects unauthenticated sockets with 4001 and cross-site cookie upgrades with 403', async () => {
    const anon = connect(urlA, {});
    expect((await anon.closed).code).toBe(REALTIME_CLOSE.UNAUTHENTICATED);

    const web = await a.app.inject({ method: 'POST', url: '/v1/auth/register', headers: browserHeaders, payload: { email: `w${Date.now()}@example.com`, password: 'correct horse battery staple', username: `w${Date.now()}`, displayName: 'W', device: { platform: 'web' } } });
    const cookie = String(web.headers['set-cookie']).split(';')[0]!;
    const evil = new WebSocket(urlA, { headers: { cookie, origin: 'https://evil.example' } });
    const status = await new Promise<number>((resolve) => evil.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
    expect(status).toBe(403);
    const good = connect(urlA, { cookie, origin: 'https://app.chatme.test' });
    expect((await good.next('hello')).v).toBe(1);
  });

  it('greets with protocol version, current seq, heartbeat interval and region', async () => {
    const u = await registerNative(a);
    const c = connect(urlA, u.auth);
    expect(await c.next('hello')).toEqual({ t: 'hello', v: 1, seq: 0, heartbeatMs: 300, region: 'iad' });
    c.send({ t: 'ping', n: 7 });
    expect(await c.next('pong')).toEqual({ t: 'pong', n: 7 });
  });

  it('closes on protocol errors and on frame floods', async () => {
    const u = await registerNative(a);
    const bad = connect(urlA, u.auth);
    await bad.next('hello');
    bad.ws.send('not json');
    expect((await bad.closed).code).toBe(REALTIME_CLOSE.PROTOCOL_ERROR);

    const flood = connect(urlA, u.auth);
    await flood.next('hello');
    for (let i = 0; i < 50; i++) flood.send({ t: 'ping' });
    expect((await flood.closed).code).toBe(REALTIME_CLOSE.RATE_LIMITED);

    const big = connect(urlA, u.auth);
    await big.next('hello');
    big.send({ t: 'ping', pad: 'x'.repeat(10_000) });
    expect((await big.closed).code).toBe(1009); // message too big, enforced by ws before parsing
  });

  it('limits connections per user across instances', async () => {
    const u = await registerNative(a);
    const open: Client[] = [];
    for (let i = 0; i < 10; i++) {
      const c = connect(i % 2 ? urlB : urlA, u.auth);
      await c.next('hello');
      open.push(c);
    }
    await sleep(50);
    const extra = connect(urlA, u.auth);
    expect((await extra.closed).code).toBe(REALTIME_CLOSE.TOO_MANY_CONNECTIONS);
  });

  it('terminates peers that stop answering heartbeats', async () => {
    const u = await registerNative(a);
    const c = connect(urlA, u.auth);
    await c.next('hello');
    // Stop answering pings, as a phone that lost signal would.
    (c.ws as unknown as { pong: () => void }).pong = () => {};
    const ws = c.ws as unknown as { _receiver: { removeAllListeners: (e: string) => void } };
    ws._receiver.removeAllListeners('ping');
    const { code } = await c.closed;
    expect(code).toBe(1006);
  });
});

describe('event delivery', () => {
  it('fans out an event committed on one instance to devices connected to another', async () => {
    const u = await registerNative(a);
    const onB = connect(urlB, u.auth);
    await onB.next('hello');
    onB.send({ t: 'resume', after: 0 });
    await sleep(50);
    expect((await patchProfile(a, u.auth, 'From A')).statusCode).toBe(200);
    const ev = await onB.next('event');
    expect(ev).toMatchObject({ t: 'event', seq: 1, type: 'me.updated', payload: { fields: ['displayName'] } });
  });

  it('replays missed events in order on resume, then continues live with no gaps or duplicates', async () => {
    const u = await registerNative(a);
    for (let i = 1; i <= 5; i++) await patchProfile(a, u.auth, `Name ${i}`);
    const c = connect(urlA, u.auth);
    expect((await c.next('hello')).seq).toBe(5);
    c.send({ t: 'resume', after: 2 });
    const replayed = [await c.next('event'), await c.next('event'), await c.next('event')];
    expect(replayed.map((e) => e.seq)).toEqual([3, 4, 5]);
    await patchProfile(b, u.auth, 'Name 6');
    expect((await c.next('event')).seq).toBe(6);
    await sleep(100);
    expect(c.frames.filter((f) => f.t === 'event')).toHaveLength(0);
  });

  it('a resume sent before the server finished setup is honoured, not dropped', async () => {
    const u = await registerNative(a);
    await patchProfile(a, u.auth, 'One');
    const ws = new WebSocket(urlA, { headers: u.auth });
    const got: ServerFrame[] = [];
    ws.on('message', (d) => got.push(JSON.parse(d.toString())));
    ws.on('open', () => ws.send(JSON.stringify({ t: 'resume', after: 0 })));
    await sleep(400);
    ws.terminate();
    expect(got.filter((f) => f.t === 'event').map((f) => (f as { seq: number }).seq)).toEqual([1]);
  });

  it('tells clients with an unusable cursor to resync', async () => {
    const u = await registerNative(a);
    await patchProfile(a, u.auth, 'x');
    const ahead = connect(urlA, u.auth);
    await ahead.next('hello');
    ahead.send({ t: 'resume', after: 99 });
    expect(await ahead.next('resync')).toEqual({ t: 'resync', seq: 1 });

    // Events older than retention were pruned: the gap cannot be served.
    await patchProfile(a, u.auth, 'y');
    await a.db.deleteFrom('user_events').where('user_id', '=', u.user.id).where('seq', '=', '1').execute();
    expect(await replay(a.db, u.user.id, 0, 2)).toBeNull();
    const old = connect(urlA, u.auth);
    await old.next('hello');
    old.send({ t: 'resume', after: 0 });
    expect(await old.next('resync')).toEqual({ t: 'resync', seq: 2 });
  });

  it('keeps per-user order under concurrent writers', async () => {
    const u = await registerNative(a);
    const c = connect(urlA, u.auth);
    await c.next('hello');
    c.send({ t: 'resume', after: 0 });
    await sleep(50);
    await Promise.all(Array.from({ length: 20 }, (_, i) => patchProfile(i % 2 ? a : b, u.auth, `N${i}`)));
    const seqs: number[] = [];
    for (let i = 0; i < 20; i++) seqs.push((await c.next('event')).seq);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('catches every socket up from the log after the bus reconnects', async () => {
    const u = await registerNative(a);
    const c = connect(urlB, u.auth);
    await c.next('hello');
    c.send({ t: 'resume', after: 0 });
    await sleep(50);
    const bus = b.app.runtime.bus as PostgresBus;
    bus.simulateDisconnect();
    expect(bus.connected).toBe(false);
    // Committed while instance B cannot hear notifications.
    await patchProfile(a, u.auth, 'during outage');
    for (let i = 0; i < 100 && !bus.connected; i++) await sleep(50);
    expect(bus.connected).toBe(true);
    expect((await c.next('event', undefined, 5000)).seq).toBe(1);
  });
});

describe('session revocation', () => {
  it('closes the revoked session socket on any instance with 4003 and keeps others open', async () => {
    const u = await registerNative(a);
    const second = await a.app.inject({ method: 'POST', url: '/v1/auth/login', headers: browserHeaders, payload: { email: u.body.email, password: u.body.password, device: { platform: 'android' } } });
    const other = { authorization: `Bearer ${second.json().token}` };
    const keep = connect(urlA, u.auth);
    const revoked = connect(urlB, other);
    await keep.next('hello');
    await revoked.next('hello');
    keep.send({ t: 'resume', after: 0 });

    const res = await a.app.inject({ method: 'DELETE', url: `/v1/sessions/${second.json().sessionId}`, headers: u.auth });
    expect(res.statusCode).toBe(204);
    expect((await revoked.closed).code).toBe(REALTIME_CLOSE.SESSION_REVOKED);
    // The surviving device hears about it so it can refresh its device list.
    expect(await keep.next('event')).toMatchObject({ type: 'session.revoked', payload: { sessionIds: [second.json().sessionId] } });
    expect(keep.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('closes every socket of a deleted account', async () => {
    const u = await registerNative(a);
    const c = connect(urlB, u.auth);
    await c.next('hello');
    await a.app.inject({ method: 'POST', url: '/v1/me/delete', headers: u.auth, payload: { password: u.body.password } });
    expect((await c.closed).code).toBe(REALTIME_CLOSE.SESSION_REVOKED);
  });

  it('revalidation closes sockets whose session expired', async () => {
    const u = await registerNative(a);
    const c = connect(urlA, u.auth);
    await c.next('hello');
    await a.db.updateTable('sessions').set({ expires_at: new Date(Date.now() - 1) }).where('id', '=', u.sessionId).execute();
    await a.app.runtime.gateway.revalidate();
    expect((await c.closed).code).toBe(REALTIME_CLOSE.SESSION_REVOKED);
  });
});

describe('presence', () => {
  it('reports presence across instances, with grace on disconnect', async () => {
    const watcher = await registerNative(a);
    const target = await registerNative(a);
    const w = connect(urlA, watcher.auth);
    await w.next('hello');
    w.send({ t: 'presence.sub', ids: [target.user.id] });
    expect(await w.next('presence')).toEqual({ t: 'presence', users: [{ id: target.user.id, online: false, lastSeenAt: null }] });

    const t1 = connect(urlB, target.auth);
    await t1.next('hello');
    expect((await w.next('presence')).users[0]).toMatchObject({ id: target.user.id, online: true });

    // A quick reconnect inside the grace period is invisible to watchers.
    t1.ws.close();
    await sleep(50);
    const t2 = connect(urlA, target.auth);
    await t2.next('hello');
    await sleep(400);
    expect(w.frames.filter((f) => f.t === 'presence')).toHaveLength(0);

    t2.ws.close();
    const off = await w.next('presence');
    expect(off.users[0]).toMatchObject({ id: target.user.id, online: false });
    expect(off.users[0]!.lastSeenAt).not.toBeNull();
  });

  it('respects showPresence: hidden users look offline and changes are announced immediately', async () => {
    const watcher = await registerNative(a);
    const target = await registerNative(a);
    const tc = connect(urlB, target.auth);
    await tc.next('hello');
    const w = connect(urlA, watcher.auth);
    await w.next('hello');
    w.send({ t: 'presence.sub', ids: [target.user.id] });
    expect((await w.next('presence')).users[0]!.online).toBe(true);

    await a.app.inject({ method: 'PATCH', url: '/v1/me/preferences', headers: target.auth, payload: { privacy: { showPresence: false } } });
    expect((await w.next('presence')).users[0]).toEqual({ id: target.user.id, online: false, lastSeenAt: null });
    w.send({ t: 'presence.sub', ids: [target.user.id] });
    expect((await w.next('presence')).users[0]).toEqual({ id: target.user.id, online: false, lastSeenAt: null });
  });

  it('does not reveal whether an id exists and bounds subscriptions', async () => {
    const watcher = await registerNative(a);
    const w = connect(urlA, watcher.auth);
    await w.next('hello');
    const ghost = '00000000-0000-4000-8000-000000000000';
    w.send({ t: 'presence.sub', ids: [ghost] });
    expect((await w.next('presence')).users).toEqual([{ id: ghost, online: false, lastSeenAt: null }]);
    w.send({ t: 'presence.sub', ids: Array.from({ length: 101 }, () => ghost) });
    expect(await w.next('error')).toEqual({ t: 'error', code: 'too_many_ids' });
    w.send({ t: 'presence.sub', ids: ['not-a-uuid'] });
    expect(await w.next('error')).toEqual({ t: 'error', code: 'too_many_ids' });
  });

  it('a crashed instance is swept by survivors and its users announced offline', async () => {
    const watcher = await registerNative(a);
    const target = await registerNative(a);
    const w = connect(urlA, watcher.auth);
    await w.next('hello');
    // Simulate a machine that died holding a connection: a presence row whose heartbeat stops.
    await a.db.insertInto('realtime_instances').values({ id: 'inst-dead', region: 'gru', heartbeat_at: new Date() }).execute();
    await a.db.insertInto('realtime_presence').values({ instance_id: 'inst-dead', user_id: target.user.id, connections: 1 }).execute();
    w.send({ t: 'presence.sub', ids: [target.user.id] });
    expect((await w.next('presence')).users[0]!.online).toBe(true);

    await a.db.updateTable('realtime_instances').set({ heartbeat_at: new Date(Date.now() - 60_000) }).where('id', '=', 'inst-dead').execute();
    expect(await a.app.runtime.presence.sweep()).toBe(1);
    expect((await w.next('presence')).users[0]).toMatchObject({ id: target.user.id, online: false });
    expect(await a.db.selectFrom('realtime_instances').select('id').where('id', '=', 'inst-dead').execute()).toHaveLength(0);
  });
});

describe('graceful drain', () => {
  it('reports not-ready, closes sockets with 1012, and refuses new ones', async () => {
    const extra = await start('inst-drain');
    try {
      const u = await registerNative(a);
      const c1 = connect(extra.url, u.auth);
      const c2 = connect(extra.url, u.auth);
      await c1.next('hello');
      await c2.next('hello');
      const draining = extra.t.app.runtime.drain();
      const ready = await extra.t.app.inject({ method: 'GET', url: '/health/ready' });
      expect(ready.statusCode).toBe(503);
      expect(ready.json().status).toBe('draining');
      const late = connect(extra.url, u.auth);
      expect((await late.closed).code).toBe(REALTIME_CLOSE.SERVICE_RESTART);
      expect((await c1.closed).code).toBe(REALTIME_CLOSE.SERVICE_RESTART);
      expect((await c2.closed).code).toBe(REALTIME_CLOSE.SERVICE_RESTART);
      await draining;
      expect(extra.t.app.runtime.gateway.size).toBe(0);
    } finally {
      await extra.t.close();
    }
  });
});
