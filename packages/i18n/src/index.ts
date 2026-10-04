import { DEFAULT_LOCALE, RTL_LOCALES, SUPPORTED_LOCALES, type Locale } from '@chatme/contracts/constants';
import { formatMessage, type MessageValues } from './format.js';

export { formatMessage, parseMessage, describeMessage, MessageSyntaxError, type MessageValues } from './format.js';
export { LOCALE_MANIFEST, type LocaleManifestEntry } from './manifest.js';
export { DEFAULT_LOCALE, RTL_LOCALES, SUPPORTED_LOCALES, type Locale };

export type Catalog = Record<string, string>;

/** Flatten nested catalog JSON into dotted keys: `{auth: {signIn: "x"}}` → `{"auth.signIn": "x"}`. */
export function flattenCatalog(input: unknown, prefix = '', out: Catalog = {}): Catalog {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError(`Catalog node at "${prefix || '<root>'}" must be an object`);
  }
  for (const [key, value] of Object.entries(input)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[path] = value;
    else flattenCatalog(value, path, out);
  }
  return out;
}

export function isSupportedLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Choose the best supported locale for a list of BCP 47 tags in preference
 * order (account preference first, then navigator.languages / device locales).
 * Matches exact code, then base language (`pt-BR` → `pt`, `tl` → `fil`).
 */
export function negotiateLocale(preferred: readonly (string | null | undefined)[]): Locale {
  const aliases: Record<string, Locale> = { tl: 'fil', in: 'id' };
  for (const tag of preferred) {
    if (!tag) continue;
    const lower = tag.toLowerCase();
    if (isSupportedLocale(lower)) return lower;
    const base = lower.split(/[-_]/)[0]!;
    if (isSupportedLocale(base)) return base;
    const alias = aliases[base];
    if (alias) return alias;
  }
  return DEFAULT_LOCALE;
}

export function directionOf(locale: Locale): 'rtl' | 'ltr' {
  return RTL_LOCALES.has(locale) ? 'rtl' : 'ltr';
}

export interface Translator {
  locale: Locale;
  dir: 'rtl' | 'ltr';
  t: (key: string, values?: MessageValues) => string;
  formatDate: (date: Date | string, options?: Intl.DateTimeFormatOptions) => string;
  formatRelative: (date: Date | string, now?: Date) => string;
  formatNumber: (n: number, options?: Intl.NumberFormatOptions) => string;
}

/**
 * Build a translator. `fallback` is only consulted when explicitly provided;
 * the validator guarantees shipped catalogs are complete, so a miss in
 * production renders the key (visible in QA) instead of silently showing English.
 */
export function createTranslator(locale: Locale, catalog: Catalog, opts: { fallback?: Catalog; timeZone?: string } = {}): Translator {
  const dtf = (o?: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: opts.timeZone, ...o });
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  return {
    locale,
    dir: directionOf(locale),
    t(key, values) {
      const source = catalog[key] ?? opts.fallback?.[key];
      if (source === undefined) return key;
      return formatMessage(locale, source, values);
    },
    formatDate(date, options = { dateStyle: 'medium', timeStyle: 'short' }) {
      return dtf(options).format(typeof date === 'string' ? new Date(date) : date);
    },
    formatRelative(date, now = new Date()) {
      const then = typeof date === 'string' ? new Date(date) : date;
      const seconds = Math.round((then.getTime() - now.getTime()) / 1000);
      const abs = Math.abs(seconds);
      if (abs < 60) return rtf.format(seconds, 'second');
      if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
      if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
      if (abs < 86400 * 30) return rtf.format(Math.round(seconds / 86400), 'day');
      return dtf({ dateStyle: 'medium' }).format(then);
    },
    formatNumber(n, options) {
      return new Intl.NumberFormat(locale, options).format(n);
    },
  };
}
