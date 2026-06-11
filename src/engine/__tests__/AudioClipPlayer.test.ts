import { describe, it, expect } from 'vitest';
import { AudioClipPlayer, type MixInto } from '../AudioClipPlayer';

/** Build a mixInto that routes a single channel hash to one stereo bus. */
function singleBus(hash: number, blockSize: number): { bus: Float32Array; mixInto: MixInto } {
  const bus = new Float32Array(blockSize * 2);
  const mixInto: MixInto = (h) => (h === hash ? bus : undefined);
  return { bus, mixInto };
}

/** Interleaved stereo PCM from per-channel arrays. */
function interleave(left: number[], right: number[]): Float32Array {
  const out = new Float32Array(left.length * 2);
  for (let i = 0; i < left.length; i++) {
    out[i * 2] = left[i]!;
    out[i * 2 + 1] = right[i]!;
  }
  return out;
}

describe('AudioClipPlayer', () => {
  it('mixes a stereo sample into the resolved channel bus', () => {
    const p = new AudioClipPlayer();
    const pcm = interleave([0.1, 0.2, 0.3, 0.4], [-0.1, -0.2, -0.3, -0.4]);
    p.loadSample(1, pcm, 2, 4);
    const { bus, mixInto } = singleBus(7, 4);
    p.startVoice(1, /*sampleHash*/ 1, /*channelHash*/ 7, 0, 1, 0);
    p.render(4, mixInto);
    expect(Array.from(bus)).toEqual([0.1, -0.1, 0.2, -0.2, 0.3, -0.3, 0.4, -0.4].map((x) => Math.fround(x)));
  });

  it('upmixes a mono sample to both output channels', () => {
    const p = new AudioClipPlayer();
    p.loadSample(2, new Float32Array([0.5, 0.25]), 1, 2);
    const { bus, mixInto } = singleBus(9, 2);
    p.startVoice(10, 2, 9, 0, 1, 0);
    p.render(2, mixInto);
    expect(Array.from(bus)).toEqual([0.5, 0.5, 0.25, 0.25]);
  });

  it('applies per-voice gain', () => {
    const p = new AudioClipPlayer();
    p.loadSample(1, interleave([1, 1], [1, 1]), 2, 2);
    const { bus, mixInto } = singleBus(0, 2);
    p.startVoice(1, 1, 0, 0, 0.5, 0);
    p.render(2, mixInto);
    expect(Array.from(bus)).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it('advances the cursor across blocks and auto-stops at sample end', () => {
    const p = new AudioClipPlayer();
    p.loadSample(1, interleave([1, 2, 3], [1, 2, 3]), 2, 3);
    p.startVoice(1, 1, 0, 0, 1, 0);
    // Block 1 of size 2 reads frames 0,1
    const b1 = singleBus(0, 2);
    p.render(2, b1.mixInto);
    expect(Array.from(b1.bus)).toEqual([1, 1, 2, 2]);
    expect(p.activeVoiceCount).toBe(1);
    // Block 2 of size 2 reads frame 2 then runs dry -> auto-stops, tail stays 0
    const b2 = singleBus(0, 2);
    p.render(2, b2.mixInto);
    expect(Array.from(b2.bus)).toEqual([3, 3, 0, 0]);
    expect(p.activeVoiceCount).toBe(0);
  });

  it('honors a sub-block start offset (voice begins partway into the block)', () => {
    const p = new AudioClipPlayer();
    p.loadSample(1, interleave([1, 1, 1, 1], [1, 1, 1, 1]), 2, 4);
    const { bus, mixInto } = singleBus(0, 4);
    p.startVoice(1, 1, 0, 0, 1, /*startOffset*/ 2);
    p.render(4, mixInto);
    // first two frames silent, voice starts at i=2
    expect(Array.from(bus)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });

  it('defers a voice whose start offset is beyond this block', () => {
    const p = new AudioClipPlayer();
    p.loadSample(1, interleave([1, 1], [1, 1]), 2, 2);
    const { bus, mixInto } = singleBus(0, 4);
    p.startVoice(1, 1, 0, 0, 1, /*startOffset*/ 6);
    p.render(4, mixInto); // 6 >= 4 -> defer, nothing this block
    expect(Array.from(bus)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    const b2 = singleBus(0, 4);
    p.render(4, b2.mixInto); // offset now 2 -> starts at i=2
    expect(Array.from(b2.bus)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });

  it('reads from a non-zero startFrame (mid-sample start)', () => {
    const p = new AudioClipPlayer();
    p.loadSample(1, interleave([10, 20, 30, 40], [10, 20, 30, 40]), 2, 4);
    const { bus, mixInto } = singleBus(0, 2);
    p.startVoice(1, 1, 0, /*startFrame*/ 2, 1, 0);
    p.render(2, mixInto);
    expect(Array.from(bus)).toEqual([30, 30, 40, 40]);
  });

  it('sums multiple voices on the same channel', () => {
    const p = new AudioClipPlayer();
    p.loadSample(1, interleave([1, 1], [1, 1]), 2, 2);
    p.loadSample(2, interleave([0.5, 0.5], [0.5, 0.5]), 2, 2);
    const { bus, mixInto } = singleBus(0, 2);
    p.startVoice(1, 1, 0, 0, 1, 0);
    p.startVoice(2, 2, 0, 0, 1, 0);
    p.render(2, mixInto);
    expect(Array.from(bus)).toEqual([1.5, 1.5, 1.5, 1.5]);
  });

  it('routes voices to their own channel bus', () => {
    const p = new AudioClipPlayer();
    p.loadSample(1, interleave([1, 1], [1, 1]), 2, 2);
    const busA = new Float32Array(4);
    const busB = new Float32Array(4);
    const mixInto: MixInto = (h) => (h === 100 ? busA : h === 200 ? busB : undefined);
    p.startVoice(1, 1, 100, 0, 1, 0);
    p.startVoice(2, 1, 200, 0, 0.5, 0);
    p.render(2, mixInto);
    expect(Array.from(busA)).toEqual([1, 1, 1, 1]);
    expect(Array.from(busB)).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it('stopVoice deactivates a specific voice immediately', () => {
    const p = new AudioClipPlayer();
    p.loadSample(1, interleave([1, 1, 1, 1], [1, 1, 1, 1]), 2, 4);
    const { bus, mixInto } = singleBus(0, 2);
    p.startVoice(42, 1, 0, 0, 1, 0);
    p.render(2, mixInto);
    expect(Array.from(bus)).toEqual([1, 1, 1, 1]);
    p.stopVoice(42);
    const b2 = singleBus(0, 2);
    p.render(2, b2.mixInto);
    expect(Array.from(b2.bus)).toEqual([0, 0, 0, 0]);
    expect(p.activeVoiceCount).toBe(0);
  });

  it('drops a voice whose sample is unknown', () => {
    const p = new AudioClipPlayer();
    const { bus, mixInto } = singleBus(0, 2);
    p.startVoice(1, /*unknown*/ 999, 0, 0, 1, 0);
    p.render(2, mixInto);
    expect(Array.from(bus)).toEqual([0, 0, 0, 0]);
    expect(p.activeVoiceCount).toBe(0);
  });

  it('keeps advancing a voice whose channel is missing this block (no crash)', () => {
    const p = new AudioClipPlayer();
    p.loadSample(1, interleave([1, 2, 3, 4], [1, 2, 3, 4]), 2, 4);
    p.startVoice(1, 1, /*channel*/ 5, 0, 1, 0);
    // Channel 5 absent -> dest undefined; cursor must still advance.
    p.render(2, () => undefined);
    expect(p.activeVoiceCount).toBe(1);
    // Now route channel 5; should resume at frame 2.
    const { bus, mixInto } = singleBus(5, 2);
    p.render(2, mixInto);
    expect(Array.from(bus)).toEqual([3, 3, 4, 4]);
  });

  it('stopAll clears every voice; removeSample forgets PCM', () => {
    const p = new AudioClipPlayer();
    p.loadSample(1, interleave([1, 1], [1, 1]), 2, 2);
    p.startVoice(1, 1, 0, 0, 1, 0);
    p.startVoice(2, 1, 0, 0, 1, 0);
    expect(p.activeVoiceCount).toBe(2);
    p.stopAll();
    expect(p.activeVoiceCount).toBe(0);
    expect(p.hasSample(1)).toBe(true);
    p.removeSample(1);
    expect(p.hasSample(1)).toBe(false);
  });
});
