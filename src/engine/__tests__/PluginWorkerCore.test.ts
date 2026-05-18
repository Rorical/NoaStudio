import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PluginWorkerCore } from '../PluginWorkerCore';
import { parseManifest, type PluginManifest } from '../PluginManifest';

let presetWasm: Uint8Array;
let presetManifest: PluginManifest;
let testWasm: Uint8Array;
let testManifest: PluginManifest;

async function loadFixture(folder: string): Promise<{ wasm: Uint8Array; manifest: PluginManifest }> {
  const raw = await readFile(path.join(folder, 'plugin.wasm'));
  const wasm = new Uint8Array(raw.byteLength);
  wasm.set(raw);
  const manifest = parseManifest(
    JSON.parse((await readFile(path.join(folder, 'plugin.json'))).toString('utf8')),
  );
  return { wasm, manifest };
}

beforeAll(async () => {
  const fixturesDir = path.resolve('src/engine/__tests__/fixtures');
  ({ wasm: presetWasm, manifest: presetManifest } = await loadFixture(path.join(fixturesDir, 'preset-test')));
  ({ wasm: testWasm, manifest: testManifest } = await loadFixture(path.join(fixturesDir, 'test-plugin')));
});

function makePresetPayload(a: number, b: number): Uint8Array {
  const out = new Uint8Array(12);
  out[0] = 0x4E; out[1] = 0x54; out[2] = 0x50; out[3] = 0x31;
  const dv = new DataView(out.buffer);
  dv.setFloat32(4, a, true);
  dv.setFloat32(8, b, true);
  return out;
}

describe('PluginWorkerCore', () => {
  it('handles HELLO by instantiating the plugin and replying READY', () => {
    const core = new PluginWorkerCore();
    const replies: unknown[] = [];
    core.handle(
      { type: 'HELLO', instanceId: 'i_a', wasm: presetWasm, manifest: presetManifest, sampleRate: 48000, maxBlockSize: 128 },
      (m) => replies.push(m),
    );
    expect(replies).toEqual([{ type: 'READY' }]);
    core.destroy();
  });

  it('handles PREPARE_PRESET by prepping and replying with stateBytes', () => {
    const core = new PluginWorkerCore();
    const replies: any[] = [];
    const send = (m: unknown) => replies.push(m);
    core.handle({ type: 'HELLO', instanceId: 'i_b', wasm: presetWasm, manifest: presetManifest, sampleRate: 48000, maxBlockSize: 128 }, send);
    core.handle({ type: 'PREPARE_PRESET', requestId: 'r1', bytes: makePresetPayload(0.4, 0.6) }, send);
    const presetReply = replies[1];
    expect(presetReply.type).toBe('PRESET_PREPARED');
    expect(presetReply.requestId).toBe('r1');
    expect(presetReply.handle).toBeGreaterThan(0);
    expect(presetReply.stateBytes.byteLength).toBe(8);
    const dv = new DataView(presetReply.stateBytes.buffer, presetReply.stateBytes.byteOffset, 8);
    expect(dv.getFloat32(0, true)).toBeCloseTo(0.4, 5);
    expect(dv.getFloat32(4, true)).toBeCloseTo(0.6, 5);
    core.destroy();
  });

  it('replies PRESET_PREPARE_FAILED when the payload is invalid', () => {
    const core = new PluginWorkerCore();
    const replies: any[] = [];
    const send = (m: unknown) => replies.push(m);
    core.handle({ type: 'HELLO', instanceId: 'i_c', wasm: presetWasm, manifest: presetManifest, sampleRate: 48000, maxBlockSize: 128 }, send);
    core.handle({ type: 'PREPARE_PRESET', requestId: 'rX', bytes: new Uint8Array([1, 2, 3]) }, send);
    const reply = replies[1];
    expect(reply.type).toBe('PRESET_PREPARE_FAILED');
    expect(reply.requestId).toBe('rX');
    expect(reply.error).toMatch(/preset/i);
    core.destroy();
  });

  it('replies PRESET_PREPARE_FAILED when prepare is requested before HELLO', () => {
    const core = new PluginWorkerCore();
    const replies: any[] = [];
    core.handle({ type: 'PREPARE_PRESET', requestId: 'r0', bytes: new Uint8Array(12) }, (m) => replies.push(m));
    expect(replies).toHaveLength(1);
    expect((replies[0] as { type: string }).type).toBe('PRESET_PREPARE_FAILED');
  });

  it('replies PRESET_PREPARE_FAILED on a v1.0 plugin without preset support', () => {
    const core = new PluginWorkerCore();
    const replies: any[] = [];
    const send = (m: unknown) => replies.push(m);
    core.handle({ type: 'HELLO', instanceId: 'i_v10', wasm: testWasm, manifest: testManifest, sampleRate: 48000, maxBlockSize: 128 }, send);
    core.handle({ type: 'PREPARE_PRESET', requestId: 'rZ', bytes: new Uint8Array(12) }, send);
    const reply = replies[1];
    expect(reply.type).toBe('PRESET_PREPARE_FAILED');
    expect(reply.error).toMatch(/no preset support/);
    core.destroy();
  });

  it('FREE_PRESET on an uninitialized core is a no-op (no reply)', () => {
    const core = new PluginWorkerCore();
    const replies: unknown[] = [];
    core.handle({ type: 'FREE_PRESET', handle: 1 }, (m) => replies.push(m));
    expect(replies).toEqual([]);
  });

  it('FREE_PRESET clears a handle so the slot is reusable', () => {
    const core = new PluginWorkerCore();
    const replies: any[] = [];
    const send = (m: unknown) => replies.push(m);
    core.handle({ type: 'HELLO', instanceId: 'i_f', wasm: presetWasm, manifest: presetManifest, sampleRate: 48000, maxBlockSize: 128 }, send);
    // Fill all 4 fixture slots.
    for (let i = 0; i < 4; i++) {
      core.handle({ type: 'PREPARE_PRESET', requestId: 'fill' + i, bytes: makePresetPayload(0.1 * (i + 1), 0) }, send);
    }
    expect(replies.filter((r) => r.type === 'PRESET_PREPARED')).toHaveLength(4);
    // 5th must fail.
    core.handle({ type: 'PREPARE_PRESET', requestId: 'full', bytes: makePresetPayload(0.9, 0) }, send);
    expect(replies[replies.length - 1].type).toBe('PRESET_PREPARE_FAILED');
    // Free slot 1, retry.
    const firstHandle = (replies.find((r) => r.requestId === 'fill0') as any).handle;
    core.handle({ type: 'FREE_PRESET', handle: firstHandle }, send);
    core.handle({ type: 'PREPARE_PRESET', requestId: 'after-free', bytes: makePresetPayload(0.95, 0) }, send);
    expect(replies[replies.length - 1].type).toBe('PRESET_PREPARED');
    core.destroy();
  });

  it('destroys cleanly and ignores subsequent messages', () => {
    const core = new PluginWorkerCore();
    const replies: unknown[] = [];
    const send = (m: unknown) => replies.push(m);
    core.handle({ type: 'HELLO', instanceId: 'i_d', wasm: presetWasm, manifest: presetManifest, sampleRate: 48000, maxBlockSize: 128 }, send);
    core.destroy();
    replies.length = 0;
    core.handle({ type: 'PREPARE_PRESET', requestId: 'after', bytes: makePresetPayload(0, 0) }, send);
    expect(replies).toEqual([]);
  });

  it('replies with an error when HELLO is sent twice', () => {
    const core = new PluginWorkerCore();
    const replies: any[] = [];
    const send = (m: unknown) => replies.push(m);
    core.handle({ type: 'HELLO', instanceId: 'i_h', wasm: presetWasm, manifest: presetManifest, sampleRate: 48000, maxBlockSize: 128 }, send);
    core.handle({ type: 'HELLO', instanceId: 'i_h', wasm: presetWasm, manifest: presetManifest, sampleRate: 48000, maxBlockSize: 128 }, send);
    expect(replies[0]).toEqual({ type: 'READY' });
    expect((replies[1] as { type: string }).type).toBe('PRESET_PREPARE_FAILED');
    core.destroy();
  });
});
