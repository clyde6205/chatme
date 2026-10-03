/** localStorage that never throws (private mode, quota, disabled storage). */
export const storage = {
  get<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable: the app still works, just without the offline snapshot */
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export const KEYS = {
  /** Snapshot of /v1/me so the signed-in shell renders with no network. Cleared on sign-out. */
  me: 'chatme.me.v1',
  locale: 'chatme.locale',
  perfMode: 'chatme.perfMode',
  installId: 'chatme.installId',
} as const;
