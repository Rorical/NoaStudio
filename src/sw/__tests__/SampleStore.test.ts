import { describe, it, expect } from 'vitest';
import { SampleStore, encodeSample, decodeSample, type SampleData } from '../SampleStore';
import { FakeDirectoryHandle } from './fakeOpfs';

function sample(): SampleData {
  const pcm = new Float32Array([0.1, -0.2, 0.3, -0.4, 0.5, -0.6]); // 3 stereo frames
  return { pcm, channels: 2, frames: 3, sampleRate: 48000 };
}

describe('encodeSample / decodeSample', () => {
  it('round-trips header + PCM exactly', () => {
    const d = sample();
    const decoded = decodeSample(encodeSample(d));
    expect(decoded.channels).toBe(2);
    expect(decoded.frames).toBe(3);
    expect(decoded.sampleRate).toBe(48000);
    expect(Array.from(decoded.pcm)).toEqual(Array.from(d.pcm));
  });

  it('prefixes a 12-byte header', () => {
    const d = sample();
    const bytes = encodeSample(d);
    expect(bytes.byteLength).toBe(12 + d.pcm.byteLength);
  });

  it('decodes from an unaligned subview', () => {
    const d = sample();
    const enc = encodeSample(d);
    // Place the blob at an odd offset inside a bigger buffer.
    const wrap = new Uint8Array(enc.byteLength + 3);
    wrap.set(enc, 3);
    const decoded = decodeSample(wrap.subarray(3));
    expect(Array.from(decoded.pcm)).toEqual(Array.from(d.pcm));
    expect(decoded.sampleRate).toBe(48000);
  });

  it('throws on a truncated blob', () => {
    expect(() => decodeSample(new Uint8Array(5))).toThrow(/truncated/);
  });
});

describe('SampleStore', () => {
  it('write then read round-trips', async () => {
    const store = new SampleStore(new FakeDirectoryHandle('samples') as unknown as FileSystemDirectoryHandle);
    await store.write('s_user1', sample());
    const got = await store.read('s_user1');
    expect(got).not.toBeNull();
    expect(got!.frames).toBe(3);
    expect(Array.from(got!.pcm)).toEqual([0.1, -0.2, 0.3, -0.4, 0.5, -0.6].map(Math.fround));
  });

  it('read returns null for an unknown id', async () => {
    const store = new SampleStore(new FakeDirectoryHandle('samples') as unknown as FileSystemDirectoryHandle);
    expect(await store.read('nope')).toBeNull();
    expect(await store.has('nope')).toBe(false);
  });

  it('has reflects presence; remove deletes', async () => {
    const store = new SampleStore(new FakeDirectoryHandle('samples') as unknown as FileSystemDirectoryHandle);
    await store.write('s1', sample());
    expect(await store.has('s1')).toBe(true);
    await store.remove('s1');
    expect(await store.has('s1')).toBe(false);
    await store.remove('s1'); // idempotent
  });

  it('list returns written ids', async () => {
    const store = new SampleStore(new FakeDirectoryHandle('samples') as unknown as FileSystemDirectoryHandle);
    await store.write('a', sample());
    await store.write('b', sample());
    expect((await store.list()).sort()).toEqual(['a', 'b']);
  });

  it('rejects unsafe ids', async () => {
    const store = new SampleStore(new FakeDirectoryHandle('samples') as unknown as FileSystemDirectoryHandle);
    await expect(store.write('../escape', sample())).rejects.toThrow(/unsafe/);
    await expect(store.read('a/b')).rejects.toThrow(/unsafe/);
    await expect(store.write('..', sample())).rejects.toThrow(/unsafe/);
  });
});
