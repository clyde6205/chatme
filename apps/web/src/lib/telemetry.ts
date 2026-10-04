import { CSRF_HEADER } from '@chatme/contracts/constants';
import { API_BASE } from './api';
import type { Capabilities, DeviceClass } from './capabilities';

type Sample = { name: 'LCP' | 'FCP' | 'INP' | 'CLS' | 'TTFB' | 'app_shell_render'; value: number };

const APP_VERSION = '0.1.0';

/**
 * Batches performance samples and sends them once the page is hidden (or the batch fills).
 * Loaded after first render; never blocks startup. Contains no personal data.
 */
export function startTelemetry(caps: Capabilities, mode: DeviceClass, shellRenderMs: number) {
  const queue: Sample[] = [{ name: 'app_shell_render', value: Math.round(shellRenderMs) }];
  const flush = () => {
    if (!queue.length || !navigator.onLine) return;
    const samples = queue.splice(0, 20);
    void fetch(`${API_BASE}/v1/telemetry/perf`, {
      method: 'POST',
      keepalive: true,
      credentials: 'include',
      headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
      body: JSON.stringify({ platform: 'web', deviceClass: mode, connection: caps.connection, appVersion: APP_VERSION, samples }),
    }).catch(() => {});
  };
  const push = (s: Sample) => {
    queue.push(s);
    if (queue.length >= 20) flush();
  };
  addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());

  void import('web-vitals').then(({ onLCP, onFCP, onINP, onCLS, onTTFB }) => {
    onLCP((m) => push({ name: 'LCP', value: m.value }));
    onFCP((m) => push({ name: 'FCP', value: m.value }));
    onINP((m) => push({ name: 'INP', value: m.value }));
    // CLS is unitless; scale ×1000 so it fits the millisecond histogram buckets.
    onCLS((m) => push({ name: 'CLS', value: m.value * 1000 }));
    onTTFB((m) => push({ name: 'TTFB', value: m.value }));
  });
}
