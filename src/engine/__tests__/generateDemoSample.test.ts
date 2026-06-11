import { describe, it, expect } from 'vitest';
import { generateDemoSample } from '../generateDemoSample';

const SR = 48000;

function rms(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v * v;
  return Math.sqrt(sum / values.length);
}

function deinterleave(pcm: Float32Array): { left: number[]; right: number[] } {
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i < pcm.length; i += 2) {
    left.push(pcm[i]!);
    right.push(pcm[i + 1]!);
  }
  return { left, right };
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const denom = Math.sqrt(da * db);
  return denom === 0 ? 0 : num / denom;
}

describe('generateDemoSample', () => {
  it('is deterministic: two identical calls produce equal samples', () => {
    const a = generateDemoSample(SR);
    const b = generateDemoSample(SR);
    expect(a.pcm.length).toBe(b.pcm.length);
    // Compare a spread of indices across the buffer.
    for (let i = 0; i < a.pcm.length; i += Math.floor(a.pcm.length / 257) + 1) {
      expect(a.pcm[i]).toBe(b.pcm[i]);
    }
    // Spot-check first and last samples explicitly.
    expect(a.pcm[0]).toBe(b.pcm[0]);
    expect(a.pcm[a.pcm.length - 1]).toBe(b.pcm[b.pcm.length - 1]);
  });

  it('reports stereo, interleaved layout', () => {
    const out = generateDemoSample(SR);
    expect(out.channels).toBe(2);
    expect(out.pcm.length).toBe(out.frames * 2);
  });

  it('uses default duration of 1.6s', () => {
    const out = generateDemoSample(SR);
    expect(out.frames).toBe(Math.round(1.6 * SR));
  });

  it('honors a custom durationSec', () => {
    const out = generateDemoSample(SR, { durationSec: 0.5 });
    expect(out.frames).toBe(Math.round(0.5 * SR));
    expect(out.pcm.length).toBe(out.frames * 2);
  });

  it('normalizes peak abs to ~0.8 and is non-silent', () => {
    const out = generateDemoSample(SR);
    let peak = 0;
    for (let i = 0; i < out.pcm.length; i++) {
      const a = Math.abs(out.pcm[i]!);
      if (a > peak) peak = a;
    }
    expect(peak).toBeGreaterThan(0.1); // non-silent
    expect(peak).toBeCloseTo(0.8, 2);
  });

  it('decays exponentially: last-quarter RMS < first-quarter RMS', () => {
    const out = generateDemoSample(SR);
    const { left } = deinterleave(out.pcm);
    const q = Math.floor(left.length / 4);
    const firstQuarter = left.slice(0, q);
    const lastQuarter = left.slice(left.length - q);
    expect(rms(lastQuarter)).toBeLessThan(rms(firstQuarter));
  });

  it('produces distinct but positively correlated L/R channels', () => {
    const out = generateDemoSample(SR);
    const { left, right } = deinterleave(out.pcm);
    // Not identical.
    let identical = true;
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) {
        identical = false;
        break;
      }
    }
    expect(identical).toBe(false);
    // Positively correlated (stereo width, not anti-phase noise).
    expect(pearson(left, right)).toBeGreaterThan(0.5);
  });

  it('produces only finite values within [-1, 1]', () => {
    const out = generateDemoSample(SR);
    // Single-pass scan: per-element expect() over ~150k samples is needlessly
    // slow, so fold to booleans and assert once.
    let allFinite = true;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < out.pcm.length; i++) {
      const v = out.pcm[i]!;
      if (!Number.isFinite(v)) allFinite = false;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(allFinite).toBe(true);
    expect(min).toBeGreaterThanOrEqual(-1);
    expect(max).toBeLessThanOrEqual(1);
  });
});
