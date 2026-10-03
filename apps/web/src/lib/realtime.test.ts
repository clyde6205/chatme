import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeClient, realtimeUrl, type RealtimeEnv, type RealtimeHandlers } from './realtime';

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  frame(f: unknown) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function setup(opts: { online?: boolean } = {}) {
  vi.useFakeTimers();
  FakeSocket.all = [];
  const listeners = new Map<string, () => void>();
  let online = opts.online ?? true;
  let hidden = false;
  const env: RealtimeEnv = {
    WebSocket: FakeSocket as never,
    setTimeout: ((fn: () => void, ms: number) => setTimeout(fn, ms)) as never,
    clearTimeout: ((id: number) => clearTimeout(id)) as never,
    random: () => 0.5,
    now: () => Date.now(),
    online: () => online,
    hidden: () => hidden,
    on: (_t, event, fn) => {
      listeners.set(event, fn);
      return () => listeners.delete(event);
    },
    location: { protocol: 'https:', host: 'chatme.pro' },
  };
  const h = { onEvent: vi.fn(), onResync: vi.fn(), onSessionEnded: vi.fn(), onStatus: vi.fn() } satisfies RealtimeHandlers;
  const client = new RealtimeClient('user-1', h, env, 'wss://api.chatme.pro/v1/realtime');
  return {
    client, h, listeners,
    sock: () => FakeSocket.all.at(-1)!,
    setOnline: (v: boolean) => { online = v; listeners.get(v ? 'online' : 'offline')?.(); },
    setHidden: (v: boolean) => { hidden = v; listeners.get('visibilitychange')?.(); },
  };
}

const hello = (seq = 0) => ({ t: 'hello', v: 1, seq, heartbeatMs: 25_000, region: 'iad' });

beforeEach(() => localStorage.clear());

describe('realtime client', () => {
  it('derives the socket URL from the API base', () => {
    expect(realtimeUrl('https://api.chatme.pro', { protocol: 'https:', host: 'chatme.pro' })).toBe('wss://api.chatme.pro/v1/realtime');
    expect(realtimeUrl('/api', { protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/api/v1/realtime');
    expect(realtimeUrl('/api', { protocol: 'https:', host: 'chatme.pro' })).toBe('wss://chatme.pro/api/v1/realtime');
  });

  it('starts from the server seq on first connect, then resumes from the persisted cursor', () => {
    const s = setup();
    s.client.start();
    s.sock().open();
    s.sock().frame(hello(7));
    expect(s.sock().sent).toEqual([{ t: 'resume', after: 7 }]);
    s.sock().frame({ t: 'event', seq: 8, type: 'me.updated', payload: {}, at: '' });
    expect(s.h.onEvent).toHaveBeenCalledTimes(1);
    // Duplicate after reconnect is ignored.
    s.sock().frame({ t: 'event', seq: 8, type: 'me.updated', payload: {}, at: '' });
    expect(s.h.onEvent).toHaveBeenCalledTimes(1);
    s.client.stop();

    const again = setup();
    again.client.start();
    again.sock().open();
    expect(again.sock().sent).toEqual([{ t: 'resume', after: 8 }]);
  });

  it('reconnects with jittered exponential backoff', () => {
    const s = setup();
    s.client.start();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const before = FakeSocket.all.length;
      s.sock().serverClose(1006);
      let waited = 0;
      while (FakeSocket.all.length === before) {
        vi.advanceTimersByTime(250);
        waited += 250;
      }
      delays.push(waited);
    }
    // random() = 0.5 → half of 1s, 2s, 4s, ... capped at 30s
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 15000, 15000]);
  });

  it('stops for good when the session is revoked', () => {
    const s = setup();
    s.client.start();
    s.sock().open();
    s.sock().serverClose(4003);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(s.h.onSessionEnded).toHaveBeenCalled();
  });

  it('waits while offline and reconnects immediately when the network returns', () => {
    const s = setup({ online: false });
    s.client.start();
    expect(FakeSocket.all).toHaveLength(0);
    s.setOnline(true);
    expect(FakeSocket.all).toHaveLength(1);
    s.sock().open();
    s.setOnline(false);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    s.setOnline(true);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('disconnects after being hidden for a minute and reconnects when visible', () => {
    const s = setup();
    s.client.start();
    s.sock().open();
    s.sock().frame(hello());
    s.setHidden(true);
    vi.advanceTimersByTime(59_000);
    expect(s.sock().readyState).toBe(1);
    vi.advanceTimersByTime(2_000);
    expect(s.sock().readyState).toBe(3);
    s.setHidden(false);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('treats a silent connection as dead and reconnects', () => {
    const s = setup();
    s.client.start();
    s.sock().open();
    s.sock().frame(hello());
    vi.advanceTimersByTime(25_000);
    expect(s.sock().sent).toContainEqual({ t: 'ping' });
    vi.advanceTimersByTime(25_000 + 1);
    vi.advanceTimersByTime(30_000);
    expect(FakeSocket.all.length).toBeGreaterThan(1);
  });

  it('asks the app to refetch state on resync', () => {
    const s = setup();
    s.client.start();
    s.sock().open();
    s.sock().frame(hello(3));
    s.sock().frame({ t: 'resync', seq: 900 });
    expect(s.h.onResync).toHaveBeenCalled();
  });
});
