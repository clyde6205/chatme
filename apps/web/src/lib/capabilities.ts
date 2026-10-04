export type DeviceClass = 'low' | 'normal' | 'high';
export type ConnectionClass = 'offline' | 'slow-2g' | '2g' | '3g' | '4g' | 'unknown';
export type PerformanceMode = 'auto' | 'low' | 'normal' | 'high';

export interface Capabilities {
  deviceClass: DeviceClass;
  connection: ConnectionClass;
  memoryGB: number | null;
  cores: number | null;
  saveData: boolean;
  reducedMotion: boolean;
  serviceWorker: boolean;
  notifications: boolean;
  share: boolean;
}

interface NavigatorLike {
  onLine?: boolean;
  deviceMemory?: number;
  hardwareConcurrency?: number;
  connection?: { effectiveType?: string; saveData?: boolean };
  serviceWorker?: unknown;
  share?: unknown;
}

interface EnvLike {
  navigator: NavigatorLike;
  matchMedia?: (q: string) => { matches: boolean };
  Notification?: unknown;
}

/**
 * Classify the device from signals browsers actually expose. Every signal is
 * optional (Safari and Firefox expose few), so missing data means "normal",
 * never "low": we only downgrade on evidence.
 */
export function detectCapabilities(env: EnvLike): Capabilities {
  const nav = env.navigator;
  const memoryGB = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null;
  const cores = typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null;
  const eff = nav.connection?.effectiveType;
  const connection: ConnectionClass =
    nav.onLine === false ? 'offline' : eff === 'slow-2g' || eff === '2g' || eff === '3g' || eff === '4g' ? eff : 'unknown';
  const saveData = nav.connection?.saveData === true;
  const reducedMotion = env.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  let deviceClass: DeviceClass = 'normal';
  if ((memoryGB !== null && memoryGB <= 2) || (cores !== null && cores <= 2) || saveData || connection === 'slow-2g' || connection === '2g') {
    deviceClass = 'low';
  } else if (memoryGB !== null && memoryGB >= 8 && cores !== null && cores >= 8 && connection !== '3g') {
    deviceClass = 'high';
  }

  return {
    deviceClass,
    connection,
    memoryGB,
    cores,
    saveData,
    reducedMotion,
    serviceWorker: 'serviceWorker' in nav && !!nav.serviceWorker,
    notifications: typeof env.Notification !== 'undefined',
    share: typeof nav.share === 'function',
  };
}

/** The user's explicit choice always wins; "auto" follows detection. */
export function resolveMode(preference: PerformanceMode, caps: Capabilities): DeviceClass {
  return preference === 'auto' ? caps.deviceClass : preference;
}

/** Reflect the effective mode on <html> so CSS can trim animation and imagery without JS branching. */
export function applyMode(mode: DeviceClass, caps: Capabilities, root: HTMLElement = document.documentElement) {
  root.dataset.perf = mode;
  root.dataset.motion = caps.reducedMotion || mode === 'low' ? 'reduce' : 'full';
}
