import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PluginInstance } from '../PluginInstance';
import { PluginChain } from '../PluginChain';
import { parseManifest, type PluginManifest } from '../PluginManifest';

const FIXTURES = path.resolve('src/engine/__tests__/fixtures');
const BLOCK = 128;
const SR = 48000;

async function loadModule(folder: string): Promise<{ module: WebAssembly.Module; manifest: PluginManifest }> {
  const raw = await readFile(path.join(folder, 'plugin.wasm'));
  const ab = new ArrayBuffer(raw.byteLength);
  new Uint8Array(ab).set(raw);
  const module = await WebAssembly.compile(ab);
  const manifestJson = JSON.parse(
    (await readFile(path.join(folder, 'plugin.json'))).toString('utf8'),
  );
  const manifest = parseManifest(manifestJson);
  return { module, manifest };
}

let fxModule: WebAssembly.Module;
let fxManifest: PluginManifest;
let genModule: WebAssembly.Module;
let genManifest: PluginManifest;

beforeAll(async () => {
  ({ module: fxModule, manifest: fxManifest } = await loadModule(path.join(FIXTURES, 'test-plugin')));
  ({ module: genModule, manifest: genManifest } = await loadModule(path.join(FIXTURES, 'gen-test')));
});

function makeFx(initialParams?: number[]): PluginInstance {
  return PluginInstance.fromModule(fxModule, fxManifest, {
    sampleRate: SR, maxBlockSize: BLOCK, ...(initialParams ? { initialParams } : {}),
  });
}
function makeGen(initialParams?: number[]): PluginInstance {
  return PluginInstance.fromModule(genModule, genManifest, {
    sampleRate: SR, maxBlockSize: BLOCK, ...(initialParams ? { initialParams } : {}),
  });
}

describe('PluginChain — empty chain', () => {
  it('produces silence when no slots are installed', () => {
    const chain = new PluginChain(BLOCK);
    const out = new Float32Array(BLOCK * 2);
    out.fill(7); // poison
    chain.processBlock(BLOCK, out);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
  });

  it('processBlock rejects a wrong-sized output buffer', () => {
    const chain = new PluginChain(BLOCK);
    expect(() => chain.processBlock(BLOCK, new Float32Array(10))).toThrow(/samples/);
  });

  it('processBlock rejects blockSize > maxBlockSize', () => {
    const chain = new PluginChain(BLOCK);
    const out = new Float32Array(256 * 2);
    expect(() => chain.processBlock(256, out)).toThrow(/maxBlockSize/);
  });
});

describe('PluginChain — single generator', () => {
  it('runs a generator in slot 0 and yields its constant output', () => {
    const chain = new PluginChain(BLOCK);
    chain.install(0, makeGen([0.3]));
    const out = new Float32Array(BLOCK * 2);
    chain.processBlock(BLOCK, out);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(0.3, 5);
    chain.dispose();
  });

  it('runs a generator in any slot index when it is the only occupant', () => {
    const chain = new PluginChain(BLOCK);
    chain.install(3, makeGen([0.4]));
    const out = new Float32Array(BLOCK * 2);
    chain.processBlock(BLOCK, out);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(0.4, 5);
    chain.dispose();
  });
});

describe('PluginChain — signal flow through FX', () => {
  it('feeds generator output through a downstream FX (volume halve)', () => {
    const chain = new PluginChain(BLOCK);
    chain.install(0, makeGen([0.6]));
    chain.install(1, makeFx([0.5]));
    const out = new Float32Array(BLOCK * 2);
    chain.processBlock(BLOCK, out);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(0.3, 5); // 0.6 * 0.5
    chain.dispose();
  });

  it('runs three slots in order: gen → fx → fx', () => {
    const chain = new PluginChain(BLOCK);
    chain.install(0, makeGen([0.5]));
    chain.install(1, makeFx([0.5])); // half
    chain.install(2, makeFx([0.5])); // half again
    const out = new Float32Array(BLOCK * 2);
    chain.processBlock(BLOCK, out);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(0.125, 5); // 0.5^3
    chain.dispose();
  });

  it('skips empty slots between occupied ones', () => {
    const chain = new PluginChain(BLOCK);
    chain.install(0, makeGen([0.4]));
    // slot 1 intentionally empty
    chain.install(2, makeFx([0.5]));
    const out = new Float32Array(BLOCK * 2);
    chain.processBlock(BLOCK, out);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(0.2, 5); // 0.4 * 0.5
    chain.dispose();
  });
});

describe('PluginChain — install / uninstall', () => {
  it('uninstall removes the slot and the chain falls back to silence', () => {
    const chain = new PluginChain(BLOCK);
    chain.install(0, makeGen([0.4]));
    chain.uninstall(0);
    const out = new Float32Array(BLOCK * 2);
    chain.processBlock(BLOCK, out);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
  });

  it('install at an already-occupied slot destroys the previous instance', () => {
    const chain = new PluginChain(BLOCK);
    const first = makeGen([0.2]);
    chain.install(0, first);
    chain.install(0, makeGen([0.7]));
    const out = new Float32Array(BLOCK * 2);
    chain.processBlock(BLOCK, out);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(0.7, 5);
    // first was destroyed; calling its process should still be a safe no-op via the `destroyed` flag.
    expect(() => first.process(BLOCK, 0)).not.toThrow();
    chain.dispose();
  });

  it('install rejects an instance whose maxBlockSize is smaller than the chain', () => {
    const chain = new PluginChain(BLOCK);
    const tiny = PluginInstance.fromModule(genModule, genManifest, { sampleRate: SR, maxBlockSize: 64 });
    expect(() => chain.install(0, tiny)).toThrow(/maxBlockSize/);
    tiny.destroy();
  });

  it('occupiedSlots returns slot indices in order', () => {
    const chain = new PluginChain(BLOCK);
    chain.install(2, makeGen([0.1]));
    chain.install(0, makeGen([0.2]));
    chain.install(5, makeFx([1.0]));
    expect(chain.occupiedSlots()).toEqual([0, 2, 5]);
    chain.dispose();
  });
});

describe('PluginChain — queued event frames', () => {
  it('drops queued events for a slot that is destroyed before the next block', () => {
    const chain = new PluginChain(BLOCK);
    chain.install(0, makeGen([0.4]));
    const frame = new Uint8Array(32); // bytes don't matter — slot will be torn down
    chain.queueEventFrame(0, frame);
    chain.uninstall(0);
    const out = new Float32Array(BLOCK * 2);
    expect(() => chain.processBlock(BLOCK, out)).not.toThrow();
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
  });

  it('queueEventFrame rejects wrong-sized frames', () => {
    const chain = new PluginChain(BLOCK);
    expect(() => chain.queueEventFrame(0, new Uint8Array(31))).toThrow(/bytes/);
  });
});
