import { describe, it, expect } from 'vitest';
import { findAdjacentClip, findClipOnAdjacentTrack } from '../findAdjacentClip';
import type { Clip } from '../projectModel';

function clip(id: string, trackId: string, start: number, length = 4): Clip {
  return { id, trackId, start, length, label: id };
}

describe('findAdjacentClip', () => {
  it('returns the next clip on the same track by start time', () => {
    const clips = [
      clip('a', 't1', 0),
      clip('b', 't1', 4),
      clip('c', 't1', 8),
    ];
    expect(findAdjacentClip(clips, 'a', 'next')).toBe('b');
    expect(findAdjacentClip(clips, 'b', 'next')).toBe('c');
  });

  it('returns the previous clip on the same track by start time', () => {
    const clips = [
      clip('a', 't1', 0),
      clip('b', 't1', 4),
      clip('c', 't1', 8),
    ];
    expect(findAdjacentClip(clips, 'c', 'prev')).toBe('b');
    expect(findAdjacentClip(clips, 'b', 'prev')).toBe('a');
  });

  it('returns null at the ends of the track', () => {
    const clips = [clip('a', 't1', 0), clip('b', 't1', 4)];
    expect(findAdjacentClip(clips, 'a', 'prev')).toBeNull();
    expect(findAdjacentClip(clips, 'b', 'next')).toBeNull();
  });

  it('ignores clips on other tracks', () => {
    const clips = [
      clip('a', 't1', 0),
      clip('x', 't2', 1),
      clip('y', 't2', 5),
      clip('b', 't1', 8),
    ];
    expect(findAdjacentClip(clips, 'a', 'next')).toBe('b');
    expect(findAdjacentClip(clips, 'b', 'prev')).toBe('a');
  });

  it('works when input clips are not in sorted order', () => {
    const clips = [
      clip('c', 't1', 8),
      clip('a', 't1', 0),
      clip('b', 't1', 4),
    ];
    expect(findAdjacentClip(clips, 'a', 'next')).toBe('b');
    expect(findAdjacentClip(clips, 'c', 'prev')).toBe('b');
  });

  it('returns null for an unknown current clip id', () => {
    const clips = [clip('a', 't1', 0)];
    expect(findAdjacentClip(clips, 'zzz', 'next')).toBeNull();
  });

  it('returns null when the track only has the current clip', () => {
    const clips = [clip('a', 't1', 0), clip('b', 't2', 0)];
    expect(findAdjacentClip(clips, 'a', 'next')).toBeNull();
    expect(findAdjacentClip(clips, 'a', 'prev')).toBeNull();
  });
});

describe('findClipOnAdjacentTrack', () => {
  const tracks = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];

  it('returns the closest clip on the next track', () => {
    const clips = [
      clip('a', 't1', 4),
      clip('b1', 't2', 0),
      clip('b2', 't2', 6),
    ];
    // a is at start 4. On t2: b1@0 (dist 4) vs b2@6 (dist 2). b2 wins.
    expect(findClipOnAdjacentTrack(clips, tracks, 'a', 'next')).toBe('b2');
  });

  it('returns the closest clip on the previous track', () => {
    const clips = [
      clip('a1', 't1', 0),
      clip('a2', 't1', 8),
      clip('b', 't2', 5),
    ];
    expect(findClipOnAdjacentTrack(clips, tracks, 'b', 'prev')).toBe('a2');
  });

  it('skips tracks with no clips', () => {
    const clips = [
      clip('a', 't1', 0),
      // t2 is empty
      clip('c', 't3', 2),
    ];
    expect(findClipOnAdjacentTrack(clips, tracks, 'a', 'next')).toBe('c');
  });

  it('returns null when there is no track with clips in the direction', () => {
    const clips = [clip('a', 't1', 0)];
    expect(findClipOnAdjacentTrack(clips, tracks, 'a', 'prev')).toBeNull();
    expect(findClipOnAdjacentTrack(clips, tracks, 'a', 'next')).toBeNull();
  });

  it('returns null for unknown current clip id', () => {
    expect(findClipOnAdjacentTrack([], tracks, 'zzz', 'next')).toBeNull();
  });

  it('ties on distance prefer the earlier-starting clip', () => {
    const clips = [
      clip('a', 't1', 4),
      clip('b1', 't2', 2), // dist 2
      clip('b2', 't2', 6), // dist 2
    ];
    expect(findClipOnAdjacentTrack(clips, tracks, 'a', 'next')).toBe('b1');
  });
});
