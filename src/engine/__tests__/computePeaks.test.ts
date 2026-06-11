import { describe, it, expect } from 'vitest';
import { computePeaks } from '../computePeaks';

describe('computePeaks', () => {
  it('returns an Int8Array of length 2*binCount', () => {
    const out = computePeaks(new Float32Array([0.1, 0.2, 0.3, 0.4]), 2);
    expect(out).toBeInstanceOf(Int8Array);
    expect(out.length).toBe(4);
  });

  it('returns an empty Int8Array for empty input', () => {
    const out = computePeaks(new Float32Array(0), 4);
    expect(out).toBeInstanceOf(Int8Array);
    expect(out.length).toBe(8);
    // every bin is [0, 0]
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('returns a zero-length Int8Array for binCount 0', () => {
    const out = computePeaks(new Float32Array([1, 2, 3]), 0);
    expect(out).toBeInstanceOf(Int8Array);
    expect(out.length).toBe(0);
  });

  it('returns a zero-length Int8Array for negative binCount', () => {
    const out = computePeaks(new Float32Array([1, 2, 3]), -3);
    expect(out).toBeInstanceOf(Int8Array);
    expect(out.length).toBe(0);
  });

  it('binCount 1 captures the global min/max', () => {
    const samples = new Float32Array([0.25, -0.5, 0.75, -0.1]);
    const out = computePeaks(samples, 1);
    expect(out.length).toBe(2);
    expect(out[0]).toBe(Math.round(-0.5 * 127)); // min
    expect(out[1]).toBe(Math.round(0.75 * 127)); // max
  });

  it('a linear ramp from -1 to 1 has monotonically increasing bin maxima', () => {
    const n = 1000;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      samples[i] = -1 + (2 * i) / (n - 1);
    }
    const binCount = 10;
    const out = computePeaks(samples, binCount);
    expect(out.length).toBe(2 * binCount);
    const flat = Array.from(out);
    let prevMax = -Infinity;
    let prevMin = -Infinity;
    for (let b = 0; b < binCount; b++) {
      const min = flat[2 * b]!;
      const max = flat[2 * b + 1]!;
      // ramp increases, so both per-bin extremes climb across bins
      expect(max).toBeGreaterThanOrEqual(prevMax);
      expect(min).toBeGreaterThanOrEqual(prevMin);
      // within a bin min <= max
      expect(min).toBeLessThanOrEqual(max);
      prevMax = max;
      prevMin = min;
    }
    // first bin starts near -1, last bin reaches +1
    expect(flat[0]).toBe(-127);
    expect(flat[2 * binCount - 1]).toBe(127);
  });

  it('an all-positive array yields non-negative min/max per bin', () => {
    const samples = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    const flat = Array.from(computePeaks(samples, 3));
    for (let b = 0; b < 3; b++) {
      expect(flat[2 * b]!).toBeGreaterThanOrEqual(0); // min
      expect(flat[2 * b + 1]!).toBeGreaterThan(0); // max
      expect(flat[2 * b]!).toBeLessThanOrEqual(flat[2 * b + 1]!);
    }
  });

  it('an all-negative array yields non-positive min/max per bin', () => {
    const samples = new Float32Array([-0.1, -0.2, -0.3, -0.4, -0.5, -0.6]);
    const flat = Array.from(computePeaks(samples, 3));
    for (let b = 0; b < 3; b++) {
      expect(flat[2 * b]!).toBeLessThan(0); // min
      expect(flat[2 * b + 1]!).toBeLessThanOrEqual(0); // max
      expect(flat[2 * b]!).toBeLessThanOrEqual(flat[2 * b + 1]!);
    }
  });

  it('handles a single-sample input', () => {
    const out = computePeaks(new Float32Array([0.5]), 1);
    expect(out.length).toBe(2);
    expect(out[0]).toBe(Math.round(0.5 * 127)); // min == that sample
    expect(out[1]).toBe(Math.round(0.5 * 127)); // max == that sample
  });

  it('binCount > length: early bins reflect single samples, later bins re-cover the tail', () => {
    // With start = floor(b*length/binCount), start is always < length for a
    // non-empty buffer (it only reaches `length` at b === binCount). So every
    // bin covers at least one real sample — there is no [0,0] gap for
    // non-empty input. binCount=5 over a 2-sample buffer maps the first few
    // bins to sample 0 and the last few to sample 1.
    const samples = new Float32Array([0.3, -0.6]);
    const binCount = 5;
    const out = computePeaks(samples, binCount);
    expect(out.length).toBe(2 * binCount);
    const flat = Array.from(out);
    // bin 0 covers sample 0 only
    expect(flat[0]).toBe(Math.round(0.3 * 127));
    expect(flat[1]).toBe(Math.round(0.3 * 127));
    // the last bin covers sample 1 (-0.6)
    expect(flat[2 * (binCount - 1)]).toBe(Math.round(-0.6 * 127));
    expect(flat[2 * (binCount - 1) + 1]).toBe(Math.round(-0.6 * 127));
    // every bin is a single quantized sample value, never a [0,0] gap
    expect(flat).not.toContain(0);
  });

  it('the start >= length guard yields [0,0] (empty buffer, every bin)', () => {
    // The only way start >= length is for an empty buffer; each bin stays [0,0].
    const out = computePeaks(new Float32Array(0), 3);
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('clamps out-of-range values: 2.0 -> 127 and -2.0 -> -127', () => {
    // The spec clamps to [-1, 1] before quantizing, so -2.0 -> -1 -> round(-127)
    // = -127; the -128 floor in the quantize formula is the lower guard and is
    // not reached once the value is already clamped into [-1, 1].
    const out = computePeaks(new Float32Array([2.0, -2.0]), 1);
    expect(out[0]).toBe(-127); // min clamped
    expect(out[1]).toBe(127); // max clamped
  });
});
