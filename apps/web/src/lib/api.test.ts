import { describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';

const respond = (status: number, body?: unknown, json = true) =>
  vi.fn(async () => new Response(body === undefined ? null : json ? JSON.stringify(body) : String(body), { status }));

describe('api client', () => {
  it('sends credentials, JSON and the CSRF header on mutations only', async () => {
    const f = respond(200, { ok: true });
    await api('/v1/x', { method: 'POST', body: { a: 1 } }, f as never);
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['x-chatme-csrf']).toBe('1');
    await api('/v1/y', {}, f as never);
    const [, getInit] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect((getInit.headers as Record<string, string>)['x-chatme-csrf']).toBeUndefined();
  });

  it('maps API error bodies to codes and fields', async () => {
    const f = respond(409, { error: { code: 'conflict_username', fields: { username: ['taken'] } } });
    await expect(api('/v1/x', { method: 'POST' }, f as never)).rejects.toMatchObject({ code: 'conflict_username', status: 409 });
  });

  it('maps network failure, gateway errors and non-JSON bodies safely', async () => {
    const down = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expect(api('/v1/x', {}, down as never)).rejects.toMatchObject({ code: 'network' });
    await expect(api('/v1/x', {}, respond(502, '<html>bad gateway</html>', false) as never)).rejects.toMatchObject({ code: 'service_unavailable' });
    await expect(api('/v1/x', {}, respond(500, 'oops', false) as never)).rejects.toBeInstanceOf(ApiError);
  });

  it('times out hung requests', async () => {
    const hang = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    await expect(api('/v1/x', { timeoutMs: 20 }, hang as never)).rejects.toMatchObject({ code: 'network' });
  });

  it('returns undefined for 204', async () => {
    expect(await api('/v1/x', { method: 'POST' }, respond(204) as never)).toBeUndefined();
  });
});
