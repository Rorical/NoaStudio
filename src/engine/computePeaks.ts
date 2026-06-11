/**
 * Downsample a PCM channel to a compact min/max envelope for waveform
 * rendering. Returns an `Int8Array` of length `2*binCount`, interleaved as
 * `[min0, max0, min1, max1, ...]`. Each min/max is the per-bin extreme float
 * clamped to [-1, 1] and quantized to a signed byte, so a whole waveform fits
 * in a fraction of the PCM's footprint.
 *
 * Bin `b` spans `samples[start..end)` with
 *   start = floor(b * length / binCount)
 *   end   = floor((b+1) * length / binCount)
 * collapsing to a single sample when the slice would otherwise be empty.
 * Bins past the end of the buffer (and every bin of an empty buffer) are
 * `[0, 0]`. Scans in place — no per-bin intermediate allocation.
 */
export function computePeaks(samples: Float32Array, binCount: number): Int8Array {
  if (binCount <= 0) return new Int8Array(0);

  const out = new Int8Array(2 * binCount);
  const n = samples.length;

  for (let b = 0; b < binCount; b++) {
    const start = Math.floor((b * n) / binCount);
    if (start >= n) continue; // out-of-range bin stays [0, 0]

    let end = Math.floor(((b + 1) * n) / binCount);
    if (end <= start) end = Math.min(start + 1, n);

    let min = samples[start] as number;
    let max = min;
    for (let i = start + 1; i < end; i++) {
      const v = samples[i] as number;
      if (v < min) min = v;
      if (v > max) max = v;
    }

    out[2 * b] = quantize(min);
    out[2 * b + 1] = quantize(max);
  }

  return out;
}

/** Clamp to [-1, 1] then to a signed byte in [-128, 127]. */
function quantize(v: number): number {
  if (v > 1) v = 1;
  else if (v < -1) v = -1;
  return Math.max(-128, Math.min(127, Math.round(v * 127)));
}
