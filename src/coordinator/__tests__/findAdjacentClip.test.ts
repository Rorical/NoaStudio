import { describe, it, expect } from 'vitest';
import { findAdjacentClip } from '../findAdjacentClip';
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
