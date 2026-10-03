import type { Locale } from '@chatme/contracts/constants';

export interface LocaleManifestEntry {
  /** Endonym shown in the language picker. */
  nativeName: string;
  /**
   * `source`   — the authoring locale (English).
   * `draft`    — complete and structurally valid, but not reviewed by a fluent human. Shown with a "draft" label.
   * `reviewed` — signed off by a fluent reviewer (record who/when in docs/i18n.md).
   */
  status: 'source' | 'draft' | 'reviewed';
  /**
   * Keys whose value may legitimately equal English (brand names, loanwords).
   * Anything else identical to English is reported as an accidental fallback.
   */
  allowIdentical: string[];
}

const BRAND = ['app.name'];

export const LOCALE_MANIFEST: Record<Locale, LocaleManifestEntry> = {
  en: { nativeName: 'English', status: 'source', allowIdentical: [] },
  es: { nativeName: 'Español', status: 'draft', allowIdentical: [...BRAND] },
  pt: { nativeName: 'Português', status: 'draft', allowIdentical: [...BRAND] },
  fr: { nativeName: 'Français', status: 'draft', allowIdentical: [...BRAND, 'settings.notifications', 'settings.notifyMessages', 'settings.notifyMentions', 'settings.performanceNormal'] },
  de: { nativeName: 'Deutsch', status: 'draft', allowIdentical: [...BRAND, 'settings.performanceNormal'] },
  it: { nativeName: 'Italiano', status: 'draft', allowIdentical: [...BRAND, 'nav.home', 'auth.email', 'auth.password', 'settings.privacy', 'settings.account', 'settings.performanceNormal'] },
  nl: { nativeName: 'Nederlands', status: 'draft', allowIdentical: [...BRAND, 'settings.privacy', 'settings.account'] },
  tr: { nativeName: 'Türkçe', status: 'draft', allowIdentical: [...BRAND] },
  ar: { nativeName: 'العربية', status: 'draft', allowIdentical: [...BRAND] },
  hi: { nativeName: 'हिन्दी', status: 'draft', allowIdentical: [...BRAND] },
  bn: { nativeName: 'বাংলা', status: 'draft', allowIdentical: [...BRAND] },
  ur: { nativeName: 'اردو', status: 'draft', allowIdentical: [...BRAND] },
  id: { nativeName: 'Bahasa Indonesia', status: 'draft', allowIdentical: [...BRAND, 'auth.email'] },
  fil: { nativeName: 'Filipino', status: 'draft', allowIdentical: [...BRAND, 'nav.home', 'nav.profile', 'auth.email', 'auth.password', 'auth.username', 'auth.displayName', 'settings.timezone', 'settings.performance', 'settings.performanceAuto', 'settings.privacy', 'settings.account', 'profile.title', 'settings.draftLabel'] },
  vi: { nativeName: 'Tiếng Việt', status: 'draft', allowIdentical: [...BRAND, 'auth.email'] },
  th: { nativeName: 'ไทย', status: 'draft', allowIdentical: [...BRAND] },
  ja: { nativeName: '日本語', status: 'draft', allowIdentical: [...BRAND] },
  ko: { nativeName: '한국어', status: 'draft', allowIdentical: [...BRAND] },
};
