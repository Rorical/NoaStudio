/**
 * Deterministically synthesize a short, pleasant stereo "vox hook"-ish demo
 * sample so audio clips have real PCM to play without committing a binary
 * asset. Fully deterministic (no Math.random, no Date) so it is unit-testable
 * and regenerable on every boot.
 *
 * Returns interleaved [L, R, L, R, ...] Float32 PCM. A tonal fundamental plus a
 * few decaying harmonics, an exponential amplitude-decay envelope with a short
 * linear attack to avoid a click, a gentle vibrato LFO, and a tiny L/R detune
 * (a few cents) for stereo width. The buffer is normalized so the absolute peak
 * is ~0.8.
 */
export interface DemoSample {
  pcm: Float32Array;
  channels: number;
  frames: number;
}

const TWO_PI = Math.PI * 2;
const CHANNELS = 2;
const TARGET_PEAK = 0.8;

// Harmonic partials: [multiple of fundamental, relative amplitude].
const HARMONICS: ReadonlyArray<readonly [number, number]> = [
  [1, 1.0],
  [2, 0.45],
  [3, 0.22],
];

// A few cents of detune between channels for stereo width. 1 cent = 2^(1/1200).
const DETUNE_CENTS = 4;
const ATTACK_SEC = 0.005; // ~5ms linear attack
const VIBRATO_HZ = 5.5;
const VIBRATO_DEPTH = 0.004; // fractional frequency modulation (+/-0.4%)
const DECAY = 4.2; // exponential decay rate over the duration

function centsToRatio(cents: number): number {
  return Math.pow(2, cents / 1200);
}

/** Synthesize one channel into `out` (non-interleaved), returning its peak abs. */
function synthChannel(
  out: Float32Array,
  frames: number,
  sampleRate: number,
  freq: number,
): number {
  const attackFrames = Math.max(1, Math.round(ATTACK_SEC * sampleRate));
  let peak = 0;
  for (let n = 0; n < frames; n++) {
    const t = n / sampleRate;
    // Gentle vibrato: modulate the instantaneous frequency by a slow LFO.
    const vibrato = 1 + VIBRATO_DEPTH * Math.sin(TWO_PI * VIBRATO_HZ * t);
    const baseFreq = freq * vibrato;

    let sample = 0;
    for (let h = 0; h < HARMONICS.length; h++) {
      const partial = HARMONICS[h]!;
      sample += partial[1] * Math.sin(TWO_PI * baseFreq * partial[0] * t);
    }

    // Exponential decay envelope with a short linear attack.
    let env = Math.exp(-DECAY * t);
    if (n < attackFrames) env *= n / attackFrames;

    const v = sample * env;
    out[n] = v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  return peak;
}

export function generateDemoSample(
  sampleRate: number,
  opts?: { durationSec?: number; freq?: number },
): DemoSample {
  const durationSec = opts?.durationSec ?? 1.6;
  const freq = opts?.freq ?? 220;
  const frames = Math.round(durationSec * sampleRate);

  const left = new Float32Array(frames);
  const right = new Float32Array(frames);

  const ratio = centsToRatio(DETUNE_CENTS);
  const peakL = synthChannel(left, frames, sampleRate, freq / ratio);
  const peakR = synthChannel(right, frames, sampleRate, freq * ratio);

  // Normalize so the absolute peak across the whole buffer is ~TARGET_PEAK.
  const peak = Math.max(peakL, peakR);
  const gain = peak > 0 ? TARGET_PEAK / peak : 0;

  const pcm = new Float32Array(frames * CHANNELS);
  for (let n = 0; n < frames; n++) {
    pcm[n * 2] = left[n]! * gain;
    pcm[n * 2 + 1] = right[n]! * gain;
  }

  return { pcm, channels: CHANNELS, frames };
}
