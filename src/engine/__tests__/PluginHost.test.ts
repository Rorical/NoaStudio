import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PluginHost } from '../PluginHost';
import { parseManifest, type PluginManifest } from '../PluginManifest';

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
  // Copy into a plain ArrayBuffer so the TS 5.7 stricter BufferSource type is satisfied.
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  bytes = ab;
});

describe('PluginHost.fromBytes', () => {
  it('instantiates and reports the manifest', async () => {
    const h = await PluginHost.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    expect(h.manifest.id).toBe('com.noa.test');
    expect(h.sampleRate).toBe(48000);
    expect(h.maxBlockSize).toBe(128);
    h.destroy();
  });
});

describe('PluginHost params', () => {
  it('writes the plugin-side default into the param buffer after init', async () => {
    const h = await PluginHost.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    expect(h.readParam(0)).toBeCloseTo(1.0);
    h.destroy();
  });

  it('round-trips setParam / readParam', async () => {
    const h = await PluginHost.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    h.setParam(0, 0.25);
    expect(h.readParam(0)).toBeCloseTo(0.25);
    h.destroy();
  });

  it('throws on out-of-range param index', async () => {
    const h = await PluginHost.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    expect(() => h.setParam(99, 0)).toThrow(/out of range/);
    expect(() => h.readParam(99)).toThrow(/out of range/);
    h.destroy();
  });
});

describe('PluginHost process', () => {
  it('passes input through unchanged when volume = 1.0', async () => {
    const h = await PluginHost.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
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
    const h = await PluginHost.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
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
    const h = await PluginHost.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    expect(() => h.process(256, 0)).toThrow(/maxBlockSize/);
    h.destroy();
  });
});

describe('PluginHost state', () => {
  it('round-trips state via getState / setState', async () => {
    const a = await PluginHost.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    a.setParam(0, 0.123);
    const snapshot = a.getState();
    expect(snapshot.byteLength).toBe(4);
    a.destroy();

    const b = await PluginHost.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    expect(b.readParam(0)).toBeCloseTo(1.0);
    expect(b.setState(snapshot)).toBe(true);
    expect(b.readParam(0)).toBeCloseTo(0.123, 5);
    b.destroy();
  });

  it('rejects setState with wrong byte count', async () => {
    const h = await PluginHost.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    expect(h.setState(new Uint8Array(7))).toBe(false);
    h.destroy();
  });
});

describe('PluginHost manifest validation', () => {
  it('rejects a manifest whose param count disagrees with the WASM', async () => {
    const wrongManifest = parseManifest({
      ...manifest,
      params: [
        { name: 'Volume', min: 0, max: 2, default: 1 },
        { name: 'Extra',  min: 0, max: 1, default: 0 },
      ],
    });
    await expect(
      PluginHost.fromBytes(bytes, wrongManifest, { sampleRate: 48000, maxBlockSize: 128 }),
    ).rejects.toThrow(/param/);
  });
});

describe('PluginHost lifecycle', () => {
  it('destroy is idempotent', async () => {
    const h = await PluginHost.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    h.destroy();
    expect(() => h.destroy()).not.toThrow();
  });
});
