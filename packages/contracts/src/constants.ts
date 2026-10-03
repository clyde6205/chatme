// Zod-free constants: safe to import from startup-critical client code.

/**
 * Locales the product ships catalogs for. Adding a locale: add its code here,
 * add `packages/i18n/locales/<code>.json`, register it in the manifest, run
 * `pnpm i18n:check`. No business logic changes.
 */
export const SUPPORTED_LOCALES = [
  'en', 'es', 'pt', 'fr', 'de', 'it', 'nl', 'tr', 'ar',
  'hi', 'bn', 'ur', 'id', 'fil', 'vi', 'th', 'ja', 'ko',
] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const RTL_LOCALES: ReadonlySet<Locale> = new Set(['ar', 'ur']);

export const DEFAULT_LOCALE: Locale = 'en';

/**
 * Stable machine-readable error codes. Clients map these to translated
 * strings (`errors.<code>` in the i18n catalogs); the API never sends
 * user-facing prose.
 */
export const ERROR_CODES = [
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict_email',
  'conflict_username',
  'invalid_credentials',
  'rate_limited',
  'csrf_failed',
  'service_unavailable',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Header every cookie-authenticated mutating request must carry (CSRF defence). */
export const CSRF_HEADER = 'x-chatme-csrf';
