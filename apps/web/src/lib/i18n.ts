import { createTranslator, flattenCatalog, isSupportedLocale, negotiateLocale, type Locale, type Translator } from '@chatme/i18n';
import { KEYS, storage } from './storage';

// Each locale becomes its own small chunk, fetched only when needed and precached by the service worker.
const loaders = import.meta.glob<{ default: unknown }>('../../../../packages/i18n/locales/*.json');

export async function loadTranslator(locale: Locale, timeZone?: string): Promise<Translator> {
  const loader = loaders[`../../../../packages/i18n/locales/${locale}.json`];
  if (!loader) throw new Error(`No catalog for ${locale}`);
  const mod = await loader();
  return createTranslator(locale, flattenCatalog(mod.default), { timeZone });
}

/** Account preference > last choice on this device > browser languages. */
export function initialLocale(accountLocale?: string | null): Locale {
  const stored = storage.get<string>(KEYS.locale);
  return negotiateLocale([accountLocale, stored && isSupportedLocale(stored) ? stored : null, ...(navigator.languages ?? [navigator.language])]);
}

export function applyDocumentLocale(t: Translator) {
  document.documentElement.lang = t.locale;
  document.documentElement.dir = t.dir;
}
