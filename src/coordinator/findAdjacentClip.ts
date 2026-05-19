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
import type { Clip } from './projectModel';

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
