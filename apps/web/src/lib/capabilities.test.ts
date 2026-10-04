import { describe, expect, it } from 'vitest';
import { detectCapabilities, resolveMode } from './capabilities';

const env = (nav: Record<string, unknown>, reduced = false) => ({
  navigator: { onLine: true, ...nav },
  matchMedia: () => ({ matches: reduced }),
});

describe('detectCapabilities', () => {
  it('treats missing signals as normal, never low', () => {
    expect(detectCapabilities(env({})).deviceClass).toBe('normal');
  });

  it.each([
    [{ deviceMemory: 1 }],
    [{ deviceMemory: 2, hardwareConcurrency: 8 }],
    [{ hardwareConcurrency: 2 }],
    [{ connection: { effectiveType: '2g' } }],
    [{ connection: { effectiveType: 'slow-2g' } }],
    [{ connection: { effectiveType: '4g', saveData: true } }],
  ])('classifies %j as low', (nav) => {
    expect(detectCapabilities(env(nav)).deviceClass).toBe('low');
  });

  it('classifies strong devices on good networks as high', () => {
    expect(detectCapabilities(env({ deviceMemory: 8, hardwareConcurrency: 8, connection: { effectiveType: '4g' } })).deviceClass).toBe('high');
    expect(detectCapabilities(env({ deviceMemory: 8, hardwareConcurrency: 8, connection: { effectiveType: '3g' } })).deviceClass).toBe('normal');
  });

  it('reports offline and reduced motion', () => {
    const c = detectCapabilities(env({ onLine: false }, true));
    expect(c.connection).toBe('offline');
    expect(c.reducedMotion).toBe(true);
  });

  it('lets an explicit preference override detection', () => {
    const low = detectCapabilities(env({ deviceMemory: 1 }));
    expect(resolveMode('auto', low)).toBe('low');
    expect(resolveMode('high', low)).toBe('high');
  });
});
