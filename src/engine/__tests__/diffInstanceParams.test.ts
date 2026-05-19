import { describe, it, expect } from 'vitest';
import { diffInstanceParams } from '../diffInstanceParams';

describe('diffInstanceParams', () => {
  it('emits one change per modified param', () => {
    const prev = new Map([['i_a', [0.5, 0, 1]]]);
    const next = new Map([['i_a', [0.7, 0, 1]]]);
    expect(diffInstanceParams(prev, next)).toEqual([
      { instanceId: 'i_a', paramIndex: 0, value: 0.7 },
    ]);
  });

  it('emits multiple changes when several params shift', () => {
    const prev = new Map([['i_a', [0.5, 0, 1]]]);
    const next = new Map([['i_a', [0.7, 1, 1]]]);
    expect(diffInstanceParams(prev, next)).toEqual([
      { instanceId: 'i_a', paramIndex: 0, value: 0.7 },
      { instanceId: 'i_a', paramIndex: 1, value: 1 },
    ]);
  });

  it('returns empty when nothing changed', () => {
    const prev = new Map([['i_a', [0.5, 0]]]);
    const next = new Map([['i_a', [0.5, 0]]]);
    expect(diffInstanceParams(prev, next)).toEqual([]);
  });

  it('skips instances only present in next (newly loaded)', () => {
    const prev = new Map<string, number[]>();
    const next = new Map([['i_new', [0.5]]]);
    expect(diffInstanceParams(prev, next)).toEqual([]);
  });

  it('skips instances only present in prev (unloaded)', () => {
    const prev = new Map([['i_gone', [0.5]]]);
    const next = new Map<string, number[]>();
    expect(diffInstanceParams(prev, next)).toEqual([]);
  });

  it('walks the intersection when param array lengths differ', () => {
    const prev = new Map([['i_a', [0.5, 0]]]);
    const next = new Map([['i_a', [0.6, 0, 1]]]);
    expect(diffInstanceParams(prev, next)).toEqual([
      { instanceId: 'i_a', paramIndex: 0, value: 0.6 },
    ]);
  });

  it('handles multiple instances independently', () => {
    const prev = new Map([['i_a', [0.5]], ['i_b', [1.0]]]);
    const next = new Map([['i_a', [0.5]], ['i_b', [0.5]]]);
    expect(diffInstanceParams(prev, next)).toEqual([
      { instanceId: 'i_b', paramIndex: 0, value: 0.5 },
    ]);
  });
});
