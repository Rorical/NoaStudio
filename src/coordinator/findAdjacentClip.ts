/**
 * Pure helper used by App.jsx's arrow-key clip navigation. Given the list of
 * clips and the currently-selected clip id, returns the id of the clip
 * immediately before or after on the same track, sorted by `start`.
 *
 * Ties on start time are broken by array order (so the next clip in the
 * project.clips order wins). Returns `null` when there is no adjacent clip
 * (selected clip is unknown, or there's no neighbour in the requested
 * direction).
 */
import type { Clip, Track } from './projectModel';

export type AdjacentDirection = 'prev' | 'next';

export function findAdjacentClip(
  clips: readonly Clip[],
  currentClipId: string,
  direction: AdjacentDirection,
): string | null {
  const current = clips.find((c) => c.id === currentClipId);
  if (!current) return null;
  const sameTrack = clips
    .filter((c) => c.trackId === current.trackId)
    .sort((a, b) => a.start - b.start);
  const idx = sameTrack.findIndex((c) => c.id === currentClipId);
  if (idx < 0) return null;
  const targetIdx = direction === 'next' ? idx + 1 : idx - 1;
  if (targetIdx < 0 || targetIdx >= sameTrack.length) return null;
  return sameTrack[targetIdx]!.id;
}

/**
 * Cross-track companion to `findAdjacentClip`. Given a clip on track X, walk
 * up/down the tracks array to find the nearest track that has clips, and
 * return the id of the clip on that track whose start time is closest to the
 * current clip's start. Ties on distance go to the earlier-starting clip.
 *
 * Returns null when there's no track with clips in the requested direction.
 */
export function findClipOnAdjacentTrack(
  clips: readonly Clip[],
  tracks: readonly Pick<Track, 'id'>[],
  currentClipId: string,
  direction: AdjacentDirection,
): string | null {
  const current = clips.find((c) => c.id === currentClipId);
  if (!current) return null;
  const trackIdx = tracks.findIndex((t) => t.id === current.trackId);
  if (trackIdx < 0) return null;

  const step = direction === 'next' ? 1 : -1;
  for (let i = trackIdx + step; i >= 0 && i < tracks.length; i += step) {
    const candidateTrackId = tracks[i]!.id;
    const candidates = clips.filter((c) => c.trackId === candidateTrackId);
    if (candidates.length === 0) continue;
    // Pick the candidate whose start is closest to the current clip's start.
    let best = candidates[0]!;
    let bestDist = Math.abs(best.start - current.start);
    for (let j = 1; j < candidates.length; j++) {
      const c = candidates[j]!;
      const d = Math.abs(c.start - current.start);
      if (d < bestDist || (d === bestDist && c.start < best.start)) {
        best = c;
        bestDist = d;
      }
    }
    return best.id;
  }
  return null;
}
