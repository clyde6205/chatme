import { describe, expect, it } from 'vitest';
import { registerRequestSchema, updatePreferencesRequestSchema, perfReportSchema } from '../src/index.js';

const base = { email: ' Ada@Example.COM ', password: 'long enough pw', username: 'Ada_1', displayName: ' Ada ', device: { platform: 'web' } };

describe('contracts', () => {
  it('normalises identity fields', () => {
    const r = registerRequestSchema.parse(base);
    expect(r).toMatchObject({ email: 'ada@example.com', username: 'ada_1', displayName: 'Ada' });
  });

  it('rejects unknown platforms, bad timezones and unsupported locales', () => {
    expect(registerRequestSchema.safeParse({ ...base, device: { platform: 'fridge' } }).success).toBe(false);
    expect(registerRequestSchema.safeParse({ ...base, timezone: 'Atlantis/Lost' }).success).toBe(false);
    expect(registerRequestSchema.safeParse({ ...base, locale: 'zz' }).success).toBe(false);
    expect(registerRequestSchema.safeParse({ ...base, timezone: 'Asia/Manila', locale: 'fil' }).success).toBe(true);
  });

  it('preference updates are strict (no mass assignment)', () => {
    expect(updatePreferencesRequestSchema.safeParse({ role: 'admin' }).success).toBe(false);
    expect(updatePreferencesRequestSchema.safeParse({ privacy: { showPresence: false } }).success).toBe(true);
  });

  it('bounds telemetry payloads', () => {
    const sample = { name: 'LCP', value: 1 };
    const ok = { platform: 'web', deviceClass: 'low', connection: '3g', appVersion: '1', samples: [sample] };
    expect(perfReportSchema.safeParse(ok).success).toBe(true);
    expect(perfReportSchema.safeParse({ ...ok, samples: Array(21).fill(sample) }).success).toBe(false);
    expect(perfReportSchema.safeParse({ ...ok, samples: [{ name: 'LCP', value: Infinity }] }).success).toBe(false);
  });
});
