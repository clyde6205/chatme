import { CSRF_HEADER, type ErrorCode } from '@chatme/contracts/constants';

export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';

export type ClientErrorCode = ErrorCode | 'network';

export class ApiError extends Error {
  constructor(
    public readonly code: ClientErrorCode,
    public readonly status: number,
    public readonly fields?: Record<string, string[]>,
  ) {
    super(code);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Thin fetch wrapper: cookie credentials, CSRF header, timeout, and mapping of
 * every failure to a stable error code the UI can translate. Never throws raw errors.
 */
export async function api<T>(path: string, opts: RequestOptions = {}, fetchImpl: typeof fetch = fetch): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  opts.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  let res: Response;
  try {
    res = await fetchImpl(`${API_BASE}${path}`, {
      method: opts.method ?? 'GET',
      credentials: 'include',
      headers: {
        ...(opts.body !== undefined && { 'content-type': 'application/json' }),
        ...(opts.method && opts.method !== 'GET' && { [CSRF_HEADER]: '1' }),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch {
    throw new ApiError('network', 0);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return undefined as T;
  let json: unknown = undefined;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body (proxy error page, etc.) */
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: ErrorCode; fields?: Record<string, string[]> } } | undefined)?.error;
    const fallback: ClientErrorCode = res.status >= 502 && res.status <= 504 ? 'service_unavailable' : res.status >= 500 ? 'internal' : 'validation_failed';
    throw new ApiError(err?.code ?? fallback, res.status, err?.fields);
  }
  return json as T;
}
