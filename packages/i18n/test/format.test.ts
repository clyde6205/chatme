import { describe, expect, it } from 'vitest';
import { formatMessage, parseMessage, MessageSyntaxError } from '../src/format.js';
import { createTranslator, negotiateLocale, directionOf } from '../src/index.js';

describe('formatMessage', () => {
  it('interpolates arguments as text', () => {
    expect(formatMessage('en', 'Hi, {name}', { name: '<b>x</b>' })).toBe('Hi, <b>x</b>');
  });

  it('leaves unknown placeholders visible rather than dropping them', () => {
    expect(formatMessage('en', 'Hi, {name}')).toBe('Hi, {name}');
  });

  it('selects CLDR plural categories per locale', () => {
    const msg = '{count, plural, one {# device} other {# devices}}';
    expect(formatMessage('en', msg, { count: 1 })).toBe('1 device');
    expect(formatMessage('en', msg, { count: 1234 })).toBe('1,234 devices');
  });

  it('handles Arabic six-way plurals', () => {
    const msg = '{n, plural, zero {z} one {o} two {t} few {f#} many {m#} other {x#}}';
    expect(formatMessage('ar', msg, { n: 0 })).toBe('z');
    expect(formatMessage('ar', msg, { n: 2 })).toBe('t');
    const nf = new Intl.NumberFormat('ar');
    expect(formatMessage('ar', msg, { n: 3 })).toBe(`f${nf.format(3)}`);
    expect(formatMessage('ar', msg, { n: 11 })).toBe(`m${nf.format(11)}`);
    expect(formatMessage('ar', msg, { n: 100 })).toBe(`x${nf.format(100)}`);
  });

  it('prefers exact =N matches', () => {
    const msg = '{count, plural, =0 {none} one {one} other {#}}';
    expect(formatMessage('en', msg, { count: 0 })).toBe('none');
  });

  it.each(['{', '}', '{a, select, x {y}}', '{n, plural, one {x}}', '{1bad}'])('rejects malformed message %s', (src) => {
    expect(() => parseMessage(src)).toThrow(MessageSyntaxError);
  });
});

describe('negotiateLocale', () => {
  it('matches exact, base and alias tags in preference order', () => {
    expect(negotiateLocale(['pt-BR', 'en'])).toBe('pt');
    expect(negotiateLocale(['xx', 'tl-PH'])).toBe('fil');
    expect(negotiateLocale([null, 'zz'])).toBe('en');
    expect(negotiateLocale(['FR-ca'])).toBe('fr');
  });
});

describe('createTranslator', () => {
  it('renders keys without silently falling back to English', () => {
    const t = createTranslator('es', { 'a.b': 'Hola {name}' });
    expect(t.t('a.b', { name: 'Ana' })).toBe('Hola Ana');
    expect(t.t('missing.key')).toBe('missing.key');
  });

  it('reports direction for RTL locales', () => {
    expect(directionOf('ar')).toBe('rtl');
    expect(directionOf('ur')).toBe('rtl');
    expect(directionOf('ja')).toBe('ltr');
  });

  it('formats dates in the account time zone', () => {
    const t = createTranslator('en', {}, { timeZone: 'Asia/Tokyo' });
    expect(t.formatDate('2026-01-01T15:30:00Z', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })).toBe('00:30');
  });
});
