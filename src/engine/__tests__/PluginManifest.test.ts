import { describe, it, expect } from 'vitest';
import { parseManifest, ABI_VERSION } from '../PluginManifest';

const VALID: unknown = {
  id: 'com.noa.test',
  name: 'Test',
  version: '1.0.0',
  abi_version: 1,
  kind: 'gen',
  params: [
    { name: 'Volume', min: 0, max: 1, default: 0.5 },
  ],
};

describe('parseManifest', () => {
  it('accepts a minimal valid manifest', () => {
    const m = parseManifest(VALID);
    expect(m.id).toBe('com.noa.test');
    expect(m.kind).toBe('gen');
    expect(m.params).toHaveLength(1);
    expect(m.params[0]!.unit).toBeUndefined();
    expect(m.params[0]!.display).toBe('linear');
    expect(m.params[0]!.step).toBe(0);
  });

  it('rejects wrong ABI version', () => {
    expect(() => parseManifest({ ...(VALID as object), abi_version: 99 })).toThrow(/abi_version/);
  });

  it('rejects unknown kind', () => {
    expect(() => parseManifest({ ...(VALID as object), kind: 'oops' })).toThrow(/kind/);
  });

  it('rejects missing required fields', () => {
    const broken = { ...(VALID as object) } as Record<string, unknown>;
    delete broken.id;
    expect(() => parseManifest(broken)).toThrow(/id/);
  });

  it('rejects params with min >= max', () => {
    expect(() =>
      parseManifest({ ...(VALID as object), params: [{ name: 'X', min: 1, max: 0, default: 0.5 }] }),
    ).toThrow(/min.*max/);
  });

  it('rejects default outside [min, max]', () => {
    expect(() =>
      parseManifest({ ...(VALID as object), params: [{ name: 'X', min: 0, max: 1, default: 2 }] }),
    ).toThrow(/default/);
  });

  it('accepts optional ui block', () => {
    const m = parseManifest({
      ...(VALID as object),
      ui: { entry: 'index.html', width: 200, height: 200 },
    });
    expect(m.ui).toEqual({ entry: 'index.html', width: 200, height: 200 });
  });

  it('rejects invalid display value', () => {
    expect(() =>
      parseManifest({
        ...(VALID as object),
        params: [{ name: 'X', min: 0, max: 1, default: 0.5, display: 'rainbow' }],
      }),
    ).toThrow(/display/);
  });

  it('preserves explicit step, unit, and display fields', () => {
    const m = parseManifest({
      ...(VALID as object),
      params: [{ name: 'Octave', min: -2, max: 2, default: 0, step: 1, unit: 'oct', display: 'log' }],
    });
    expect(m.params[0]).toEqual({
      name: 'Octave', min: -2, max: 2, default: 0, step: 1, unit: 'oct', display: 'log',
    });
  });

  it('exposes the host ABI version constant', () => {
    expect(ABI_VERSION).toBe(1);
  });
});
