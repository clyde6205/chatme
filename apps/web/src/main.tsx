import type { Me } from '@chatme/contracts';
import { render } from 'preact';
import { App } from './app';
import { applyMode, detectCapabilities, resolveMode, type PerformanceMode } from './lib/capabilities';
import { applyDocumentLocale, initialLocale, loadTranslator } from './lib/i18n';
import { KEYS, storage } from './lib/storage';
import { registerServiceWorker } from './lib/sw';
import { startTelemetry } from './lib/telemetry';
import { AppProvider } from './state';
import './styles.css';

/**
 * Startup path. No network request happens before first render:
 * identity comes from the local snapshot, the locale catalog from the
 * (service-worker cached) bundle. Everything else is deferred to idle time.
 */
async function boot() {
  const caps = detectCapabilities(window as never);
  const cachedMe = storage.get<Me>(KEYS.me);
  const pref = cachedMe?.performanceMode ?? storage.get<PerformanceMode>(KEYS.perfMode) ?? 'auto';
  const mode = resolveMode(pref, caps);
  applyMode(mode, caps);

  const t = await loadTranslator(initialLocale(cachedMe?.locale), cachedMe?.timezone);
  applyDocumentLocale(t);

  render(
    <AppProvider initial={{ t, me: cachedMe, caps }}>
      <App />
    </AppProvider>,
    document.getElementById('app')!,
  );
  const shellRenderMs = performance.now();

  const idle = (cb: () => void) => ('requestIdleCallback' in window ? requestIdleCallback(cb, { timeout: 3000 }) : setTimeout(cb, 1500));
  idle(() => {
    registerServiceWorker();
    startTelemetry(caps, mode, shellRenderMs);
  });
}

void boot();
