import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PluginWorker } from '../PluginWorker';
import type { MessagePortLike } from '../WorkletProtocol';
import { parseManifest, type PluginManifest } from '../PluginManifest';

function makePort() {
  const outgoing: unknown[] = [];
  let handler: ((e: MessageEvent) => void) | null = null;
  const port: MessagePortLike = {
    postMessage(msg) { outgoing.push(msg); },
    get onmessage() { return handler; },
    set onmessage(h) { handler = h; },
  };
  return {
    port,
    outgoing,
    fire(data: unknown) {
      handler?.({ data } as MessageEvent);
    },
  };
}

let wasm: Uint8Array;
let manifest: PluginManifest;

beforeAll(async () => {
  const buf = await readFile(path.resolve('src/engine/__tests__/fixtures/preset-test/plugin.wasm'));
  wasm = new Uint8Array(buf.byteLength);
  wasm.set(buf);
  manifest = parseManifest({
    id: 'com.noa.preset-test', name: 'Preset Test', version: '0.0.1', abi_version: 1, kind: 'fx',
    params: [
      { name: 'A', min: 0, max: 1, default: 0 },
      { name: 'B', min: 0, max: 1, default: 0 },
    ],
  });
});

describe('PluginWorker.spawn', () => {
  it('posts HELLO carrying wasm bytes + manifest + audio config', () => {
    const { port, outgoing } = makePort();
    const w = new PluginWorker(port);
    void w.spawn({ instanceId: 'i_a', wasm, manifest, sampleRate: 48000, maxBlockSize: 128 });
    expect(outgoing).toHaveLength(1);
    const msg = outgoing[0] as {
      type: string; instanceId: string; wasm: Uint8Array; manifest: PluginManifest;
      sampleRate: number; maxBlockSize: number;
    };
    expect(msg.type).toBe('HELLO');
    expect(msg.instanceId).toBe('i_a');
    expect(msg.wasm).toBe(wasm);
    expect(msg.manifest.id).toBe('com.noa.preset-test');
    expect(msg.sampleRate).toBe(48000);
    expect(msg.maxBlockSize).toBe(128);
  });

  it('resolves on READY', async () => {
    const { port, fire } = makePort();
    const w = new PluginWorker(port);
    const p = w.spawn({ instanceId: 'i_b', wasm, manifest, sampleRate: 48000, maxBlockSize: 128 });
    fire({ type: 'READY' });
    await expect(p).resolves.toBeUndefined();
  });

  it('rejects if spawn is called twice', async () => {
    const { port } = makePort();
    const w = new PluginWorker(port);
    void w.spawn({ instanceId: 'i_c', wasm, manifest, sampleRate: 48000, maxBlockSize: 128 });
    await expect(
      w.spawn({ instanceId: 'i_c', wasm, manifest, sampleRate: 48000, maxBlockSize: 128 }),
    ).rejects.toThrow(/already/);
  });
});

describe('PluginWorker.preparePreset', () => {
  async function ready() {
    const ctx = makePort();
    const w = new PluginWorker(ctx.port);
    const p = w.spawn({ instanceId: 'i_r', wasm, manifest, sampleRate: 48000, maxBlockSize: 128 });
    ctx.fire({ type: 'READY' });
    await p;
    return { ...ctx, w };
  }

  it('posts PREPARE_PRESET with a generated requestId + bytes', async () => {
    const { w, outgoing } = await ready();
    void w.preparePreset(new Uint8Array([1, 2, 3]));
    expect(outgoing).toHaveLength(2);
    const msg = outgoing[1] as { type: string; requestId: string; bytes: Uint8Array };
    expect(msg.type).toBe('PREPARE_PRESET');
    expect(typeof msg.requestId).toBe('string');
    expect(Array.from(msg.bytes)).toEqual([1, 2, 3]);
  });

  it('resolves with handle + stateBytes when worker replies with PRESET_PREPARED', async () => {
    const { w, outgoing, fire } = await ready();
    const p = w.preparePreset(new Uint8Array(12));
    const sent = outgoing[1] as { requestId: string };
    fire({
      type: 'PRESET_PREPARED',
      requestId: sent.requestId,
      handle: 7,
      stateBytes: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]),
    });
    const result = await p;
    expect(result.handle).toBe(7);
    expect(Array.from(result.stateBytes)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
  });

  it('rejects on PRESET_PREPARE_FAILED', async () => {
    const { w, outgoing, fire } = await ready();
    const p = w.preparePreset(new Uint8Array(0));
    const sent = outgoing[1] as { requestId: string };
    fire({ type: 'PRESET_PREPARE_FAILED', requestId: sent.requestId, error: 'bad payload' });
    await expect(p).rejects.toThrow(/bad payload/);
  });

  it('ignores responses with unknown requestIds', async () => {
    const { w, outgoing, fire } = await ready();
    const p = w.preparePreset(new Uint8Array(12));
    const sent = outgoing[1] as { requestId: string };
    // Stray response for a different request.
    fire({ type: 'PRESET_PREPARED', requestId: 'other', handle: 99, stateBytes: new Uint8Array(0) });
    // Real one still resolves.
    fire({ type: 'PRESET_PREPARED', requestId: sent.requestId, handle: 1, stateBytes: new Uint8Array(8) });
    const result = await p;
    expect(result.handle).toBe(1);
  });

  it('rejects when preparePreset is called before spawn resolves', () => {
    const { port } = makePort();
    const w = new PluginWorker(port);
    expect(() => w.preparePreset(new Uint8Array())).toThrow(/not spawned/);
  });
});

describe('PluginWorker.freePreset', () => {
  it('posts FREE_PRESET with the handle', async () => {
    const ctx = makePort();
    const w = new PluginWorker(ctx.port);
    const p = w.spawn({ instanceId: 'i_f', wasm, manifest, sampleRate: 48000, maxBlockSize: 128 });
    ctx.fire({ type: 'READY' });
    await p;
    ctx.outgoing.length = 0;
    w.freePreset(5);
    expect(ctx.outgoing).toEqual([{ type: 'FREE_PRESET', handle: 5 }]);
  });
});

describe('PluginWorker.dispose', () => {
  it('rejects every pending request', async () => {
    const ctx = makePort();
    const w = new PluginWorker(ctx.port);
    const sp = w.spawn({ instanceId: 'i_d', wasm, manifest, sampleRate: 48000, maxBlockSize: 128 });
    ctx.fire({ type: 'READY' });
    await sp;
    const a = w.preparePreset(new Uint8Array(12));
    const b = w.preparePreset(new Uint8Array(12));
    w.dispose();
    await expect(a).rejects.toThrow(/disposed/);
    await expect(b).rejects.toThrow(/disposed/);
  });

  it('rejects spawn after disposal', async () => {
    const { port } = makePort();
    const w = new PluginWorker(port);
    w.dispose();
    await expect(
      w.spawn({ instanceId: 'i_x', wasm, manifest, sampleRate: 48000, maxBlockSize: 128 }),
    ).rejects.toThrow(/disposed/);
  });

  it('makes freePreset a no-op after disposal', async () => {
    const { port, outgoing } = makePort();
    const w = new PluginWorker(port);
    w.dispose();
    w.freePreset(1);
    expect(outgoing).toEqual([]);
  });
});
