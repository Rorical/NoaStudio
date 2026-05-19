/**
 * Tap-tempo helper. Given a list of click timestamps (most recent last),
 * return the average BPM, or `null` when there aren't enough taps or the
 * spacing falls outside the supported 30..300 BPM range.
 *
 * Pure function — App.jsx maintains the timestamp array and the inactivity
 * reset (drop taps older than ~2 seconds before calling).
 */
export function calcTapBpm(timestampsMs: readonly number[]): number | null {
  if (timestampsMs.length < 2) return null;
  let totalInterval = 0;
  let n = 0;
  for (let i = 1; i < timestampsMs.length; i++) {
    const dt = timestampsMs[i]! - timestampsMs[i - 1]!;
    if (dt <= 0) return null; // out-of-order or duplicate timestamps
    totalInterval += dt;
    n++;
  }
  const avgMs = totalInterval / n;
  const bpm = 60000 / avgMs;
  if (bpm < 30 || bpm > 300) return null;
  // Round to one decimal so the toolbar displays a tidy value.
  return Math.round(bpm * 10) / 10;
}
