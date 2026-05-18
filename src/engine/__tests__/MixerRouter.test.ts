import { describe, it, expect } from 'vitest';
import { MixerRouter, type RouterChain, type RoutingConfig } from '../MixerRouter';

/**
 * Stub chain that fills its output buffer with a constant value. Pass-through
 * mode (`signal: 'passthrough'`) copies inBus to outBus, simulating an empty
 * channel FX chain.
 */
class StubChain implements RouterChain {
  constructor(private readonly signal: number | 'passthrough') {}
  processBlock(blockSize: number, outBus: Float32Array, inBus?: Float32Array): void {
    if (this.signal === 'passthrough') {
      if (inBus) outBus.set(inBus.subarray(0, blockSize * 2));
      else outBus.fill(0, 0, blockSize * 2);
      return;
    }
    for (let i = 0; i < blockSize * 2; i++) outBus[i] = this.signal;
  }
  queueEventFrame(): void { /* not used in router tests */ }
}

function basicConfig(): RoutingConfig {
  return {
    tracks: [
      { id: 't1', chainId: 't1', channelId: 'm1', mute: false, solo: false },
    ],
    channels: [
      { id: 'm1', fxChainId: 'm1', vol: 1, pan: 0, mute: false, solo: false, sendTo: 'm0' },
      { id: 'm0', fxChainId: 'm0', vol: 1, pan: 0, mute: false, solo: false, sendTo: null },
    ],
    channelOrder: ['m1', 'm0'],
  };
}

describe('MixerRouter — single track to master', () => {
  it('routes track signal through its channel to master', () => {
    const router = new MixerRouter(8);
    router.installChain('t1', new StubChain(0.5));
    router.updateRouting(basicConfig());
    const out = new Float32Array(16);
    router.processBlock(8, out);
    for (let i = 0; i < 16; i++) expect(out[i]).toBeCloseTo(0.5, 5);
  });

  it('outputs silence when no tracks are configured', () => {
    const router = new MixerRouter(8);
    router.updateRouting({ tracks: [], channels: [], channelOrder: [] });
    const out = new Float32Array(16).fill(99);
    router.processBlock(8, out);
    for (let i = 0; i < 16; i++) expect(out[i]).toBe(0);
  });
});

describe('MixerRouter — mute / solo', () => {
  it('muted tracks contribute nothing', () => {
    const router = new MixerRouter(8);
    router.installChain('t1', new StubChain(0.5));
    const cfg = basicConfig();
    cfg.tracks[0]!.mute = true;
    router.updateRouting(cfg);
    const out = new Float32Array(16);
    router.processBlock(8, out);
    for (let i = 0; i < 16; i++) expect(out[i]).toBe(0);
  });

  it('solo isolates the soloed track', () => {
    const router = new MixerRouter(8);
    router.installChain('t1', new StubChain(0.5));
    router.installChain('t2', new StubChain(0.3));
    router.updateRouting({
      tracks: [
        { id: 't1', chainId: 't1', channelId: 'm1', mute: false, solo: false },
        { id: 't2', chainId: 't2', channelId: 'm2', mute: false, solo: true },
      ],
      channels: [
        { id: 'm1', fxChainId: 'm1', vol: 1, pan: 0, mute: false, solo: false, sendTo: 'm0' },
        { id: 'm2', fxChainId: 'm2', vol: 1, pan: 0, mute: false, solo: false, sendTo: 'm0' },
        { id: 'm0', fxChainId: 'm0', vol: 1, pan: 0, mute: false, solo: false, sendTo: null },
      ],
      channelOrder: ['m1', 'm2', 'm0'],
    });
    const out = new Float32Array(16);
    router.processBlock(8, out);
    // Only t2 audible.
    for (let i = 0; i < 16; i++) expect(out[i]).toBeCloseTo(0.3, 5);
  });
});

describe('MixerRouter — multi-track sums', () => {
  it('two tracks into one channel sum at the channel', () => {
    const router = new MixerRouter(8);
    router.installChain('t1', new StubChain(0.2));
    router.installChain('t2', new StubChain(0.3));
    router.updateRouting({
      tracks: [
        { id: 't1', chainId: 't1', channelId: 'm1', mute: false, solo: false },
        { id: 't2', chainId: 't2', channelId: 'm1', mute: false, solo: false },
      ],
      channels: [
        { id: 'm1', fxChainId: 'm1', vol: 1, pan: 0, mute: false, solo: false, sendTo: 'm0' },
        { id: 'm0', fxChainId: 'm0', vol: 1, pan: 0, mute: false, solo: false, sendTo: null },
      ],
      channelOrder: ['m1', 'm0'],
    });
    const out = new Float32Array(16);
    router.processBlock(8, out);
    for (let i = 0; i < 16; i++) expect(out[i]).toBeCloseTo(0.5, 5);
  });
});

describe('MixerRouter — channel FX', () => {
  it('channel FX chain receives the channel mix as input', () => {
    const router = new MixerRouter(8);
    router.installChain('t1', new StubChain(0.5));
    // Channel m1's FX doubles its input.
    const doubleChain: RouterChain = {
      processBlock(blockSize, outBus, inBus) {
        if (!inBus) { outBus.fill(0, 0, blockSize * 2); return; }
        for (let i = 0; i < blockSize * 2; i++) outBus[i] = inBus[i]! * 2;
      },
      queueEventFrame() {},
    };
    router.installChain('m1', doubleChain);
    router.updateRouting(basicConfig());
    const out = new Float32Array(16);
    router.processBlock(8, out);
    for (let i = 0; i < 16; i++) expect(out[i]).toBeCloseTo(1.0, 5);
  });
});

describe('MixerRouter — vol / pan', () => {
  it('channel vol scales the output', () => {
    const router = new MixerRouter(8);
    router.installChain('t1', new StubChain(1.0));
    const cfg = basicConfig();
    cfg.channels.find((c) => c.id === 'm1')!.vol = 0.5;
    router.updateRouting(cfg);
    const out = new Float32Array(16);
    router.processBlock(8, out);
    for (let i = 0; i < 16; i++) expect(out[i]).toBeCloseTo(0.5, 5);
  });

  it('full-left pan zeros the right channel', () => {
    const router = new MixerRouter(8);
    router.installChain('t1', new StubChain(1.0));
    const cfg = basicConfig();
    cfg.channels.find((c) => c.id === 'm1')!.pan = -1;
    router.updateRouting(cfg);
    const out = new Float32Array(16);
    router.processBlock(8, out);
    // Stereo interleaved: even indices = L, odd = R. R should be ~0.
    for (let i = 0; i < 8; i++) {
      expect(out[i * 2 + 1]).toBeCloseTo(0, 5);
      expect(out[i * 2]).toBeGreaterThan(0.5);
    }
  });
});

describe('MixerRouter — sends + bus routing', () => {
  it('channels sending to a bus accumulate before the bus runs', () => {
    const router = new MixerRouter(8);
    router.installChain('t1', new StubChain(0.2));
    router.installChain('t2', new StubChain(0.3));
    router.updateRouting({
      tracks: [
        { id: 't1', chainId: 't1', channelId: 'm1', mute: false, solo: false },
        { id: 't2', chainId: 't2', channelId: 'm2', mute: false, solo: false },
      ],
      channels: [
        // m1 + m2 → mB (drum bus) → m0
        { id: 'm1', fxChainId: 'm1', vol: 1, pan: 0, mute: false, solo: false, sendTo: 'mB' },
        { id: 'm2', fxChainId: 'm2', vol: 1, pan: 0, mute: false, solo: false, sendTo: 'mB' },
        { id: 'mB', fxChainId: 'mB', vol: 1, pan: 0, mute: false, solo: false, sendTo: 'm0' },
        { id: 'm0', fxChainId: 'm0', vol: 1, pan: 0, mute: false, solo: false, sendTo: null },
      ],
      channelOrder: ['m1', 'm2', 'mB', 'm0'],
    });
    const out = new Float32Array(16);
    router.processBlock(8, out);
    for (let i = 0; i < 16; i++) expect(out[i]).toBeCloseTo(0.5, 5);
  });
});

describe('MixerRouter — instance event routing', () => {
  it('queueEvent routes the frame to the registered chain + slot', () => {
    const router = new MixerRouter(8);
    const seen: Array<{ slot: number; bytes: number[] }> = [];
    const recordingChain: RouterChain = {
      processBlock(_blockSize, outBus) { outBus.fill(0); },
      queueEventFrame(slot, frame) { seen.push({ slot, bytes: Array.from(frame) }); },
    };
    router.installChain('t1', recordingChain);
    router.registerInstance(42, 't1', 0);
    const frame = new Uint8Array(32);
    frame[0] = 1; // type byte
    router.queueEvent(42, frame);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.slot).toBe(0);
    expect(seen[0]!.bytes[0]).toBe(1);
  });

  it('queueEvent for an unknown instance is a no-op', () => {
    const router = new MixerRouter(8);
    const frame = new Uint8Array(32);
    expect(() => router.queueEvent(999, frame)).not.toThrow();
  });
});

describe('MixerRouter — channel meters', () => {
  it('returns peak/rms per channel in channelOrder', () => {
    const router = new MixerRouter(8);
    router.installChain('t1', new StubChain(0.5));
    router.updateRouting(basicConfig());
    const out = new Float32Array(16);
    const meters = router.processBlock(8, out);
    const m1 = meters.find((m) => m.channelId === 'm1')!;
    const m0 = meters.find((m) => m.channelId === 'm0')!;
    expect(m1.peak).toBeCloseTo(0.5, 5);
    expect(m0.peak).toBeCloseTo(0.5, 5);
  });
});

describe('MixerRouter — chain lifecycle', () => {
  it('removeChain drops the chain from the routing map', () => {
    const router = new MixerRouter(8);
    router.installChain('t1', new StubChain(0.5));
    router.updateRouting(basicConfig());
    router.removeChain('t1');
    const out = new Float32Array(16);
    router.processBlock(8, out);
    for (let i = 0; i < 16; i++) expect(out[i]).toBe(0);
  });

  it('reusing the same chain id replaces the prior chain', () => {
    const router = new MixerRouter(8);
    router.installChain('t1', new StubChain(0.1));
    router.installChain('t1', new StubChain(0.7));
    router.updateRouting(basicConfig());
    const out = new Float32Array(16);
    router.processBlock(8, out);
    for (let i = 0; i < 16; i++) expect(out[i]).toBeCloseTo(0.7, 5);
  });
});
