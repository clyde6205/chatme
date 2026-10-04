import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateCatalogs } from '../src/validate.js';

const dir = join(__dirname, '..', 'locales');
const load = () => {
  const raw: Record<string, any> = {};
  for (const f of readdirSync(dir)) raw[f.replace('.json', '')] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  return raw;
};

describe('shipped catalogs', () => {
  it('pass every structural check', () => {
    expect(validateCatalogs(load())).toEqual([]);
  });
});

describe('validator catches breakage', () => {
  it('missing key', () => {
    const raw = load();
    delete raw.de.auth.signIn;
    expect(validateCatalogs(raw)).toContainEqual({ locale: 'de', key: 'auth.signIn', problem: 'missing key' });
  });

  it('broken interpolation', () => {
    const raw = load();
    raw.fr.home.greeting = 'Bonjour, {nom}';
    const problems = validateCatalogs(raw).filter((i) => i.key === 'home.greeting').map((i) => i.problem);
    expect(problems).toEqual(expect.arrayContaining(['missing placeholders: name', 'unknown placeholders: nom']));
  });

  it('missing plural category for the locale', () => {
    const raw = load();
    raw.ar.devices.count = '{count, plural, one {x} other {y}}';
    const issue = validateCatalogs(raw).find((i) => i.locale === 'ar' && i.key === 'devices.count');
    expect(issue?.problem).toMatch(/missing CLDR categories: .*few/);
  });

  it('accidental English fallback', () => {
    const raw = load();
    raw.ja.nav.settings = 'Settings';
    expect(validateCatalogs(raw).some((i) => i.locale === 'ja' && i.key === 'nav.settings' && /identical to English/.test(i.problem))).toBe(true);
  });

  it('Latin text in an RTL catalog', () => {
    const raw = load();
    raw.ur.nav.back = 'Back';
    expect(validateCatalogs(raw).some((i) => i.locale === 'ur' && i.key === 'nav.back' && /RTL/.test(i.problem))).toBe(true);
  });

  it('missing catalog file', () => {
    const raw = load();
    delete raw.ko;
    expect(validateCatalogs(raw)).toContainEqual({ locale: 'ko', problem: 'catalog file missing' });
  });
});
