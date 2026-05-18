import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkletProtocol, type MessagePortLike } from '../WorkletProtocol';
import { parseManifest, type PluginManifest } from '../PluginManifest';

/**
 * Hand-rolled MessagePort stub. Captures outgoing messages and lets the test
 * synthesise the worklet's responses by calling `fire(...)`.
 */
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
  // Real WASM bytes so the test exercises postMessage with the real shape.
  const buf = await readFile(path.resolve('src/engine/__tests__/fixtures/test-plugin/plugin.wasm'));
  wasm = new Uint8Array(buf.byteLength);
  wasm.set(buf);
  manifest = parseManifest({
    id: 'com.noa.test',
    name: 'Test', version: '0.0.1', abi_version: 1, kind: 'fx',
    params: [{ name: 'Volume', min: 0, max: 2, default: 1 }],
  });
});

describe('WorkletProtocol.loadPlugin', () => {
  it('posts INSTANTIATE_PLUGIN with the requested args', () => {
    const { port, outgoing } = makePort();
    const proto = new WorkletProtocol(port);
    void proto.loadPlugin({ instanceId: 'i_a', slot: 0, wasm, manifest });

    expect(outgoing).toHaveLength(1);
    const msg = outgoing[0] as { type: string; instanceId: string; slot: number; wasm: Uint8Array; manifest: PluginManifest };
    expect(msg.type).toBe('INSTANTIATE_PLUGIN');
    expect(msg.instanceId).toBe('i_a');
    expect(msg.slot).toBe(0);
    expect(msg.wasm).toBe(wasm);
    expect(msg.manifest.id).toBe('com.noa.test');
  });

  it('resolves on INSTANCE_READY with matching instanceId', async () => {
    const { port, fire } = makePort();
    const proto = new WorkletProtocol(port);
    const promise = proto.loadPlugin({ instanceId: 'i_b', slot: 0, wasm, manifest });

    const paramSab = new SharedArrayBuffer(64);
    const notifySab = new SharedArrayBuffer(32);
    fire({
      type: 'INSTANCE_READY',
      instanceId: 'i_b', slot: 0,
      paramRingSab: paramSab,
      notifyRingSab: notifySab,
    });

    const result = await promise;
    expect(result.instanceId).toBe('i_b');
    expect(result.slot).toBe(0);
    expect(result.paramRingSab).toBe(paramSab);
    expect(result.notifyRingSab).toBe(notifySab);
  });

  it('rejects on INSTANCE_ERROR with the error message', async () => {
    const { port, fire } = makePort();
    const proto = new WorkletProtocol(port);
    const promise = proto.loadPlugin({ instanceId: 'i_c', slot: 0, wasm, manifest });

    fire({ type: 'INSTANCE_ERROR', instanceId: 'i_c', error: 'WASM not happy' });

    await expect(promise).rejects.toThrow(/i_c.*WASM not happy/);
  });

  it('ignores messages whose instanceId does not match any pending request', async () => {
    const { port, fire } = makePort();
    const proto = new WorkletProtocol(port);
    const promise = proto.loadPlugin({ instanceId: 'i_d', slot: 0, wasm, manifest });

    fire({ type: 'INSTANCE_READY', instanceId: 'someone-else', slot: 9, paramRingSab: new SharedArrayBuffer(0), notifyRingSab: new SharedArrayBuffer(0) });

    // The real response still resolves it.
    fire({ type: 'INSTANCE_READY', instanceId: 'i_d', slot: 0, paramRingSab: new SharedArrayBuffer(32), notifyRingSab: new SharedArrayBuffer(16) });
    await expect(promise).resolves.toMatchObject({ instanceId: 'i_d', slot: 0 });
  });

  it('rejects when the same instanceId is loaded twice without first resolving', async () => {
    const { port } = makePort();
    const proto = new WorkletProtocol(port);
    void proto.loadPlugin({ instanceId: 'i_dup', slot: 0, wasm, manifest });
    await expect(
      proto.loadPlugin({ instanceId: 'i_dup', slot: 1, wasm, manifest }),
    ).rejects.toThrow(/already pending/);
  });

  it('passes initialParams through when provided', () => {
    const { port, outgoing } = makePort();
    const proto = new WorkletProtocol(port);
    void proto.loadPlugin({
      instanceId: 'i_p', slot: 0, wasm, manifest, initialParams: [0.5, 0.25],
    });
    const msg = outgoing[0] as { initialParams?: number[] };
    expect(msg.initialParams).toEqual([0.5, 0.25]);
  });

  it('does not include an initialParams key when not provided', () => {
    const { port, outgoing } = makePort();
    const proto = new WorkletProtocol(port);
    void proto.loadPlugin({ instanceId: 'i_np', slot: 0, wasm, manifest });
    expect(outgoing[0]).not.toHaveProperty('initialParams');
  });
});

describe('WorkletProtocol.unloadInstance', () => {
  it('posts DESTROY_INSTANCE with the slot', () => {
    const { port, outgoing } = makePort();
    const proto = new WorkletProtocol(port);
    proto.unloadInstance(3);
    expect(outgoing).toEqual([{ type: 'DESTROY_INSTANCE', slot: 3 }]);
  });
});

describe('WorkletProtocol.applyPresetState', () => {
  it('posts APPLY_PRESET_STATE with the slot and state bytes', () => {
    const { port, outgoing } = makePort();
    const proto = new WorkletProtocol(port);
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    proto.applyPresetState(2, bytes);
    expect(outgoing).toEqual([{ type: 'APPLY_PRESET_STATE', slot: 2, stateBytes: bytes }]);
  });

  it('is a no-op after dispose', () => {
    const { port, outgoing } = makePort();
    const proto = new WorkletProtocol(port);
    proto.dispose();
    proto.applyPresetState(0, new Uint8Array());
    expect(outgoing).toEqual([]);
  });
});

describe('WorkletProtocol.dispose', () => {
  it('rejects every pending load promise', async () => {
    const { port } = makePort();
    const proto = new WorkletProtocol(port);
    const a = proto.loadPlugin({ instanceId: 'i_x', slot: 0, wasm, manifest });
    const b = proto.loadPlugin({ instanceId: 'i_y', slot: 1, wasm, manifest });

    proto.dispose();

    await expect(a).rejects.toThrow(/disposed/);
    await expect(b).rejects.toThrow(/disposed/);
  });

  it('refuses new loadPlugin calls after disposal', async () => {
    const { port } = makePort();
    const proto = new WorkletProtocol(port);
    proto.dispose();
    await expect(
      proto.loadPlugin({ instanceId: 'i_z', slot: 0, wasm, manifest }),
    ).rejects.toThrow(/disposed/);
  });

  it('makes unloadInstance a no-op after disposal', () => {
    const { port, outgoing } = makePort();
    const proto = new WorkletProtocol(port);
    proto.dispose();
    proto.unloadInstance(0);
    expect(outgoing).toEqual([]);
  });
});
