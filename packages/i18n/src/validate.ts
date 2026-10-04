import { SUPPORTED_LOCALES, RTL_LOCALES, type Locale } from '@chatme/contracts/constants';
import { describeMessage, MessageSyntaxError } from './format.js';
import { flattenCatalog, type Catalog } from './index.js';
import { LOCALE_MANIFEST } from './manifest.js';

export interface ValidationIssue {
  locale: string;
  key?: string;
  problem: string;
}

/**
 * Structural checks every shipped locale must pass. Pure function so it is
 * unit-testable; `scripts/validate.ts` feeds it the files on disk.
 */
export function validateCatalogs(raw: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const flat: Partial<Record<Locale, Catalog>> = {};

  for (const locale of SUPPORTED_LOCALES) {
    if (!(locale in raw)) {
      issues.push({ locale, problem: 'catalog file missing' });
      continue;
    }
    try {
      flat[locale] = flattenCatalog(raw[locale]);
    } catch (e) {
      issues.push({ locale, problem: `invalid catalog structure: ${(e as Error).message}` });
    }
  }
  for (const extra of Object.keys(raw)) {
    if (!(SUPPORTED_LOCALES as readonly string[]).includes(extra)) {
      issues.push({ locale: extra, problem: 'catalog present for unsupported locale (add it to SUPPORTED_LOCALES)' });
    }
  }

  const source = flat.en;
  if (!source) return issues;

  const sourceShape = new Map<string, ReturnType<typeof describeMessage>>();
  for (const [key, msg] of Object.entries(source)) {
    try {
      sourceShape.set(key, describeMessage(msg));
    } catch (e) {
      issues.push({ locale: 'en', key, problem: (e as MessageSyntaxError).message });
    }
  }

  for (const locale of SUPPORTED_LOCALES) {
    const catalog = flat[locale];
    if (!catalog) continue;
    const manifest = LOCALE_MANIFEST[locale];
    const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories as string[];

    for (const key of Object.keys(source)) {
      if (!(key in catalog)) issues.push({ locale, key, problem: 'missing key' });
    }
    for (const [key, msg] of Object.entries(catalog)) {
      const expected = sourceShape.get(key);
      if (!(key in source)) {
        issues.push({ locale, key, problem: 'key not present in source (en)' });
        continue;
      }
      if (msg.trim() === '') {
        issues.push({ locale, key, problem: 'empty translation' });
        continue;
      }
      let shape: ReturnType<typeof describeMessage>;
      try {
        shape = describeMessage(msg);
      } catch (e) {
        issues.push({ locale, key, problem: `syntax: ${(e as Error).message}` });
        continue;
      }
      if (!expected) continue;
      const missingArgs = [...expected.args].filter((a) => !shape.args.has(a));
      const extraArgs = [...shape.args].filter((a) => !expected.args.has(a));
      if (missingArgs.length) issues.push({ locale, key, problem: `missing placeholders: ${missingArgs.join(', ')}` });
      if (extraArgs.length) issues.push({ locale, key, problem: `unknown placeholders: ${extraArgs.join(', ')}` });

      for (const [arg] of expected.plurals) {
        const selectors = shape.plurals.get(arg);
        if (!selectors) {
          issues.push({ locale, key, problem: `"${arg}" must be a plural argument` });
          continue;
        }
        const missingCats = categories.filter((c) => !selectors.has(c));
        if (missingCats.length) issues.push({ locale, key, problem: `plural "${arg}" missing CLDR categories: ${missingCats.join(', ')}` });
        const invalid = [...selectors].filter((s) => !s.startsWith('=') && !categories.includes(s));
        if (invalid.length) issues.push({ locale, key, problem: `plural "${arg}" has categories ${locale} does not use: ${invalid.join(', ')}` });
      }

      if (locale !== 'en' && msg === source[key] && !manifest.allowIdentical.includes(key)) {
        issues.push({ locale, key, problem: 'identical to English (accidental fallback?); add to allowIdentical if intended' });
      }
    }

    if (RTL_LOCALES.has(locale)) {
      // An RTL catalog written in Latin script would indicate an English paste.
      const latinOnly = Object.entries(catalog).filter(
        ([k, v]) => !manifest.allowIdentical.includes(k) && !/[\u0590-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(v),
      );
      for (const [k] of latinOnly) issues.push({ locale, key: k, problem: 'RTL locale string contains no RTL script' });
    }
  }
  return issues;
}
