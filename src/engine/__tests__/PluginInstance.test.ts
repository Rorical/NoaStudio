import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PluginInstance, NOTIFY_PARAM_CHANGED } from '../PluginInstance';
import { parseManifest, type PluginManifest } from '../PluginManifest';
import { RingBuffer } from '../RingBuffer';
import {
  EVENT_FRAME_SIZE,
  encodeEvent,
  EVT_PARAM_SET,
} from '../EngineEvent';

const FIXTURE_DIR = path.resolve('src/engine/__tests__/fixtures/test-plugin');

let bytes: ArrayBuffer;
const manifest: PluginManifest = parseManifest({
  id: 'com.noa.test',
  name: 'Test',
  version: '0.0.1',
  abi_version: 1,
  kind: 'fx',
  params: [{ name: 'Volume', min: 0, max: 2, default: 1 }],
});

beforeAll(async () => {
  const buf = await readFile(path.join(FIXTURE_DIR, 'plugin.wasm'));
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  bytes = ab;
});

describe('PluginInstance.fromBytes', () => {
  it('instantiates and reports the manifest', async () => {
    const h = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    expect(h.manifest.id).toBe('com.noa.test');
    expect(h.sampleRate).toBe(48000);
    expect(h.maxBlockSize).toBe(128);
    expect(h.paramRingSab).toBeNull();
    expect(h.notifyRingSab).toBeNull();
    h.destroy();
  });
});

describe('PluginInstance.fromModule (sync)', () => {
  it('returns an instance synchronously when given a compiled module', async () => {
    const module = await WebAssembly.compile(bytes);
    // No await around fromModule — must complete synchronously.
    const h = PluginInstance.fromModule(module, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    expect(h).toBeInstanceOf(PluginInstance);
    h.destroy();
  });

  it('honours initialParams by writing them before first read', async () => {
    const module = await WebAssembly.compile(bytes);
    const h = PluginInstance.fromModule(module, manifest, {
      sampleRate: 48000, maxBlockSize: 128, initialParams: [0.42],
    });
    expect(h.readParam(0)).toBeCloseTo(0.42);
    h.destroy();
  });
});

describe('PluginInstance params', () => {
  it('writes the plugin-side default into the param buffer after init', async () => {
    const h = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    expect(h.readParam(0)).toBeCloseTo(1.0);
    h.destroy();
  });

  it('round-trips setParam / readParam', async () => {
    const h = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    h.setParam(0, 0.25);
    expect(h.readParam(0)).toBeCloseTo(0.25);
    h.destroy();
  });

  it('throws on out-of-range param index', async () => {
    const h = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    expect(() => h.setParam(99, 0)).toThrow(/out of range/);
    expect(() => h.readParam(99)).toThrow(/out of range/);
    h.destroy();
  });
});

describe('PluginInstance process', () => {
  it('passes input through unchanged when volume = 1.0', async () => {
    const h = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    const inp = new Float32Array(128 * 2);
    for (let i = 0; i < inp.length; i++) inp[i] = 0.5;
    h.writeInput(inp);
    h.process(128, 0);
    const out = new Float32Array(128 * 2);
    h.readOutput(out);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(0.5);
    h.destroy();
  });

  it('scales output by the current Volume param', async () => {
    const h = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    h.setParam(0, 0.5);
    const inp = new Float32Array(128 * 2);
    for (let i = 0; i < inp.length; i++) inp[i] = 0.8;
    h.writeInput(inp);
    h.process(128, 0);
    const out = new Float32Array(128 * 2);
    h.readOutput(out);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(0.4, 5);
    h.destroy();
  });

  it('rejects nFrames larger than maxBlockSize', async () => {
    const h = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    expect(() => h.process(256, 0)).toThrow(/maxBlockSize/);
    h.destroy();
  });
});

describe('PluginInstance state', () => {
  it('round-trips state via getState / setState', async () => {
    const a = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    a.setParam(0, 0.123);
    const snapshot = a.getState();
    expect(snapshot.byteLength).toBe(4);
    a.destroy();

    const b = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    expect(b.readParam(0)).toBeCloseTo(1.0);
    expect(b.setState(snapshot)).toBe(true);
    expect(b.readParam(0)).toBeCloseTo(0.123, 5);
    b.destroy();
  });

  it('rejects setState with wrong byte count', async () => {
    const h = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    expect(h.setState(new Uint8Array(7))).toBe(false);
    h.destroy();
  });
});

describe('PluginInstance manifest validation', () => {
  it('rejects a manifest whose param count disagrees with the WASM', async () => {
    const wrongManifest = parseManifest({
      ...manifest,
      params: [
        { name: 'Volume', min: 0, max: 2, default: 1 },
        { name: 'Extra',  min: 0, max: 1, default: 0 },
      ],
    });
    await expect(
      PluginInstance.fromBytes(bytes, wrongManifest, { sampleRate: 48000, maxBlockSize: 128 }),
    ).rejects.toThrow(/param/);
  });
});

describe('PluginInstance lifecycle', () => {
  it('destroy is idempotent', async () => {
    const h = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    h.destroy();
    expect(() => h.destroy()).not.toThrow();
  });
});

describe('PluginInstance per-instance rings', () => {
  it('exposes paramRingSab and notifyRingSab when allocateRings is true', async () => {
    const h = await PluginInstance.fromBytes(bytes, manifest, {
      sampleRate: 48000, maxBlockSize: 128, allocateRings: true,
    });
    expect(h.paramRingSab).toBeInstanceOf(SharedArrayBuffer);
    expect(h.notifyRingSab).toBeInstanceOf(SharedArrayBuffer);
    h.destroy();
  });

  it('drainParamRing applies ParamSet frames into the plugin param buffer', async () => {
    const h = await PluginInstance.fromBytes(bytes, manifest, {
      sampleRate: 48000, maxBlockSize: 128, allocateRings: true,
    });
    const sender = new RingBuffer(h.paramRingSab!);
    const frame = new Uint8Array(EVENT_FRAME_SIZE);
    encodeEvent({
      type: EVT_PARAM_SET, frameOffset: 0, targetId: 0, paramIndex: 0, value: 0.7,
    }, frame);
    expect(sender.push(frame)).toBe(true);

    expect(h.drainParamRing()).toBe(1);
    expect(h.readParam(0)).toBeCloseTo(0.7, 5);
    h.destroy();
  });

  it('drainParamRing ignores out-of-range paramIndex', async () => {
    const h = await PluginInstance.fromBytes(bytes, manifest, {
      sampleRate: 48000, maxBlockSize: 128, allocateRings: true,
    });
    const sender = new RingBuffer(h.paramRingSab!);
    const frame = new Uint8Array(EVENT_FRAME_SIZE);
    encodeEvent({
      type: EVT_PARAM_SET, frameOffset: 0, targetId: 0, paramIndex: 99, value: 9.9,
    }, frame);
    sender.push(frame);

    expect(h.drainParamRing()).toBe(1); // frame is consumed
    expect(h.readParam(0)).toBeCloseTo(1.0); // but the in-range value at index 0 is untouched
    h.destroy();
  });

  it('drainParamRing returns 0 when rings are not allocated', async () => {
    const h = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    expect(h.drainParamRing()).toBe(0);
    h.destroy();
  });

  it('pushNotifyParamChanged enqueues a ParamChanged frame', async () => {
    const h = await PluginInstance.fromBytes(bytes, manifest, {
      sampleRate: 48000, maxBlockSize: 128, allocateRings: true,
    });
    expect(h.pushNotifyParamChanged(0, 0.33, 17)).toBe(true);

    const reader = new RingBuffer(h.notifyRingSab!);
    const frame = new Uint8Array(16);
    expect(reader.pop(frame)).toBe(true);
    const v = new DataView(frame.buffer);
    expect(v.getUint8(0)).toBe(NOTIFY_PARAM_CHANGED);
    expect(v.getUint32(4, true)).toBe(0);
    expect(v.getFloat32(8, true)).toBeCloseTo(0.33, 5);
    expect(v.getUint32(12, true)).toBe(17);
    h.destroy();
  });

  it('pushNotifyParamChanged returns false when rings are not allocated', async () => {
    const h = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    expect(h.pushNotifyParamChanged(0, 0, 0)).toBe(false);
    h.destroy();
  });

  it('pushNotifyParamChanged rejects an out-of-range paramIndex', async () => {
    const h = await PluginInstance.fromBytes(bytes, manifest, {
      sampleRate: 48000, maxBlockSize: 128, allocateRings: true,
    });
    expect(h.pushNotifyParamChanged(99, 0, 0)).toBe(false);
    h.destroy();
  });
});
