import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkletProtocol, type MessagePortLike, type LoadPluginArgs } from '../WorkletProtocol';
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
  const buf = await readFile(path.resolve('src/engine/__tests__/fixtures/test-plugin/plugin.wasm'));
  wasm = new Uint8Array(buf.byteLength);
  wasm.set(buf);
  manifest = parseManifest({
    id: 'com.noa.test',
    name: 'Test', version: '0.0.1', abi_version: 1, kind: 'fx',
    params: [{ name: 'Volume', min: 0, max: 2, default: 1 }],
  });
});

function args(overrides: Partial<LoadPluginArgs> = {}): LoadPluginArgs {
  return {
    instanceId: 'i', numericId: 1, chainId: 'm0', slot: 0,
    wasm, manifest,
    ...overrides,
  };
}

describe('WorkletProtocol.loadPlugin', () => {
  it('posts INSTANTIATE_PLUGIN with the requested args', () => {
    const { port, outgoing } = makePort();
    const proto = new WorkletProtocol(port);
    void proto.loadPlugin(args({ instanceId: 'i_a', numericId: 42, chainId: 't1', slot: 0 }));

    expect(outgoing).toHaveLength(1);
    const msg = outgoing[0] as {
      type: string; instanceId: string; numericId: number; chainId: string; slot: number;
      wasm: Uint8Array; manifest: PluginManifest;
    };
    expect(msg.type).toBe('INSTANTIATE_PLUGIN');
    expect(msg.instanceId).toBe('i_a');
    expect(msg.numericId).toBe(42);
    expect(msg.chainId).toBe('t1');
    expect(msg.slot).toBe(0);
    expect(msg.wasm).toBe(wasm);
    expect(msg.manifest.id).toBe('com.noa.test');
  });

  it('resolves on INSTANCE_READY with matching instanceId', async () => {
    const { port, fire } = makePort();
    const proto = new WorkletProtocol(port);
    const promise = proto.loadPlugin(args({ instanceId: 'i_b', numericId: 7, chainId: 't2', slot: 0 }));

    const paramSab = new SharedArrayBuffer(64);
    const notifySab = new SharedArrayBuffer(32);
    fire({
      type: 'INSTANCE_READY',
      instanceId: 'i_b', numericId: 7, chainId: 't2', slot: 0,
      paramRingSab: paramSab,
      notifyRingSab: notifySab,
    });

    const result = await promise;
    expect(result.instanceId).toBe('i_b');
    expect(result.numericId).toBe(7);
    expect(result.chainId).toBe('t2');
    expect(result.slot).toBe(0);
    expect(result.paramRingSab).toBe(paramSab);
    expect(result.notifyRingSab).toBe(notifySab);
  });

  it('rejects on INSTANCE_ERROR with the error message', async () => {
    const { port, fire } = makePort();
    const proto = new WorkletProtocol(port);
    const promise = proto.loadPlugin(args({ instanceId: 'i_c' }));

    fire({ type: 'INSTANCE_ERROR', instanceId: 'i_c', error: 'WASM not happy' });

    await expect(promise).rejects.toThrow(/i_c.*WASM not happy/);
  });

  it('ignores messages whose instanceId does not match any pending request', async () => {
    const { port, fire } = makePort();
    const proto = new WorkletProtocol(port);
    const promise = proto.loadPlugin(args({ instanceId: 'i_d' }));

    fire({
      type: 'INSTANCE_READY', instanceId: 'someone-else',
      numericId: 0, chainId: 'm0', slot: 9,
      paramRingSab: new SharedArrayBuffer(0), notifyRingSab: new SharedArrayBuffer(0),
    });

    fire({
      type: 'INSTANCE_READY', instanceId: 'i_d',
      numericId: 1, chainId: 'm0', slot: 0,
      paramRingSab: new SharedArrayBuffer(32), notifyRingSab: new SharedArrayBuffer(16),
    });
    await expect(promise).resolves.toMatchObject({ instanceId: 'i_d', slot: 0 });
  });

  it('rejects when the same instanceId is loaded twice without first resolving', async () => {
    const { port } = makePort();
    const proto = new WorkletProtocol(port);
    void proto.loadPlugin(args({ instanceId: 'i_dup' }));
    await expect(
      proto.loadPlugin(args({ instanceId: 'i_dup', slot: 1 })),
    ).rejects.toThrow(/already pending/);
  });

  it('passes initialParams through when provided', () => {
    const { port, outgoing } = makePort();
    const proto = new WorkletProtocol(port);
    void proto.loadPlugin(args({ instanceId: 'i_p', initialParams: [0.5, 0.25] }));
    const msg = outgoing[0] as { initialParams?: number[] };
    expect(msg.initialParams).toEqual([0.5, 0.25]);
  });

  it('does not include an initialParams key when not provided', () => {
    const { port, outgoing } = makePort();
    const proto = new WorkletProtocol(port);
    void proto.loadPlugin(args({ instanceId: 'i_np' }));
    expect(outgoing[0]).not.toHaveProperty('initialParams');
  });
});

describe('WorkletProtocol.unloadInstance', () => {
  it('posts DESTROY_INSTANCE with the numericId + chainId + slot', () => {
    const { port, outgoing } = makePort();
    const proto = new WorkletProtocol(port);
    proto.unloadInstance({ numericId: 5, chainId: 't3', slot: 0 });
    expect(outgoing).toEqual([{ type: 'DESTROY_INSTANCE', numericId: 5, chainId: 't3', slot: 0 }]);
  });
});

describe('WorkletProtocol.applyPresetState', () => {
  it('posts APPLY_PRESET_STATE with the chainId + slot + state bytes', () => {
    const { port, outgoing } = makePort();
    const proto = new WorkletProtocol(port);
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    proto.applyPresetState({ chainId: 't1', slot: 0, stateBytes: bytes });
    expect(outgoing).toEqual([{ type: 'APPLY_PRESET_STATE', chainId: 't1', slot: 0, stateBytes: bytes }]);
  });

  it('is a no-op after dispose', () => {
    const { port, outgoing } = makePort();
    const proto = new WorkletProtocol(port);
    proto.dispose();
    proto.applyPresetState({ chainId: 't1', slot: 0, stateBytes: new Uint8Array() });
    expect(outgoing).toEqual([]);
  });
});

describe('WorkletProtocol.updateRouting', () => {
  it('posts UPDATE_ROUTING with the given config', () => {
    const { port, outgoing } = makePort();
    const proto = new WorkletProtocol(port);
    const cfg = { tracks: [], channels: [], channelOrder: [] };
    proto.updateRouting(cfg);
    expect(outgoing).toEqual([{ type: 'UPDATE_ROUTING', config: cfg }]);
  });

  it('is a no-op after dispose', () => {
    const { port, outgoing } = makePort();
    const proto = new WorkletProtocol(port);
    proto.dispose();
    proto.updateRouting({ tracks: [], channels: [], channelOrder: [] });
    expect(outgoing).toEqual([]);
  });
});

describe('WorkletProtocol.dispose', () => {
  it('rejects every pending load promise', async () => {
    const { port } = makePort();
    const proto = new WorkletProtocol(port);
    const a = proto.loadPlugin(args({ instanceId: 'i_x' }));
    const b = proto.loadPlugin(args({ instanceId: 'i_y', slot: 1 }));

    proto.dispose();

    await expect(a).rejects.toThrow(/disposed/);
    await expect(b).rejects.toThrow(/disposed/);
  });

  it('refuses new loadPlugin calls after disposal', async () => {
    const { port } = makePort();
    const proto = new WorkletProtocol(port);
    proto.dispose();
    await expect(
      proto.loadPlugin(args({ instanceId: 'i_z' })),
    ).rejects.toThrow(/disposed/);
  });

  it('makes unloadInstance a no-op after disposal', () => {
    const { port, outgoing } = makePort();
    const proto = new WorkletProtocol(port);
    proto.dispose();
    proto.unloadInstance({ numericId: 0, chainId: 'm0', slot: 0 });
    expect(outgoing).toEqual([]);
  });
});
