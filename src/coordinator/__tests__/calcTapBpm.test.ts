import { describe, it, expect } from 'vitest';
import { calcTapBpm } from '../calcTapBpm';

describe('calcTapBpm', () => {
  it('returns null for fewer than 2 taps', () => {
    expect(calcTapBpm([])).toBeNull();
    expect(calcTapBpm([1000])).toBeNull();
  });

  it('computes BPM from the average interval', () => {
    // 500 ms per beat → 120 BPM
    expect(calcTapBpm([0, 500, 1000, 1500])).toBeCloseTo(120, 5);
  });

  it('averages varying intervals', () => {
    // Intervals: 400, 500, 600 → mean 500 → 120 BPM
    expect(calcTapBpm([0, 400, 900, 1500])).toBeCloseTo(120, 5);
  });

  it('rounds to one decimal place', () => {
    // 7 taps with 333ms interval → 60000/333 ≈ 180.18...
    const ts = [0, 333, 666, 999, 1332, 1665, 1998];
    const bpm = calcTapBpm(ts);
    // Should be rounded to nearest 0.1.
    expect(Math.round(bpm! * 10)).toBe(bpm! * 10);
  });

  it('returns null for BPM out of range (< 30)', () => {
    // 3000 ms per beat → 20 BPM
    expect(calcTapBpm([0, 3000, 6000])).toBeNull();
  });

  it('returns null for BPM out of range (> 300)', () => {
    // 100 ms per beat → 600 BPM
    expect(calcTapBpm([0, 100, 200])).toBeNull();
  });

  it('returns null when timestamps go backwards', () => {
    expect(calcTapBpm([1000, 500])).toBeNull();
  });

  it('returns null on duplicate timestamps', () => {
    expect(calcTapBpm([500, 500])).toBeNull();
  });
});
