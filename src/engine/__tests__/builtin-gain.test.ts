import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PluginInstance } from '../PluginInstance';
import { parseManifest, type PluginManifest } from '../PluginManifest';

const PLUGIN_DIR = path.resolve('src/builtin-plugins/gain');
const SR = 48000;
const BLOCK = 128;

let bytes: ArrayBuffer;
let manifest: PluginManifest;

beforeAll(async () => {
  const buf = await readFile(path.join(PLUGIN_DIR, 'gain.wasm'));
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  bytes = ab;
  manifest = parseManifest(
    JSON.parse((await readFile(path.join(PLUGIN_DIR, 'plugin.json'))).toString('utf8')),
  );
});

describe('com.noa.gain', () => {
  it('has the expected manifest', () => {
    expect(manifest.id).toBe('com.noa.gain');
    expect(manifest.kind).toBe('fx');
    expect(manifest.params.map((p) => p.name)).toEqual(['Gain']);
  });

  it('passes audio through unchanged at default gain (1.0)', async () => {
    const inst = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: SR, maxBlockSize: BLOCK });
    expect(inst.readParam(0)).toBeCloseTo(1.0);
    const inp = new Float32Array(BLOCK * 2);
    for (let i = 0; i < inp.length; i++) inp[i] = (i % 2 === 0 ? 0.3 : -0.3);
    inst.writeInput(inp);
    inst.process(BLOCK, 0);
    const out = new Float32Array(BLOCK * 2);
    inst.readOutput(out);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(inp[i]!, 5);
    inst.destroy();
  });

  it('scales output by the Gain param', async () => {
    const inst = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: SR, maxBlockSize: BLOCK });
    inst.setParam(0, 2.5);
    const inp = new Float32Array(BLOCK * 2);
    for (let i = 0; i < inp.length; i++) inp[i] = 0.2;
    inst.writeInput(inp);
    inst.process(BLOCK, 0);
    const out = new Float32Array(BLOCK * 2);
    inst.readOutput(out);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(0.5, 5); // 0.2 * 2.5
    inst.destroy();
  });

  it('outputs silence when Gain is 0', async () => {
    const inst = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: SR, maxBlockSize: BLOCK });
    inst.setParam(0, 0);
    const inp = new Float32Array(BLOCK * 2);
    inp.fill(0.7);
    inst.writeInput(inp);
    inst.process(BLOCK, 0);
    const out = new Float32Array(BLOCK * 2);
    inst.readOutput(out);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
    inst.destroy();
  });

  it('round-trips state (4 bytes)', async () => {
    const a = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: SR, maxBlockSize: BLOCK });
    a.setParam(0, 1.75);
    const snap = a.getState();
    expect(snap.byteLength).toBe(4);
    a.destroy();

    const b = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: SR, maxBlockSize: BLOCK });
    expect(b.setState(snap)).toBe(true);
    expect(b.readParam(0)).toBeCloseTo(1.75, 5);
    b.destroy();
  });
});
