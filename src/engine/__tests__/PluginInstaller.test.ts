import { describe, it, expect } from 'vitest';
import { zipSync } from 'fflate';
import { PluginInstaller } from '../PluginInstaller';
import { OpfsPluginStore } from '../../sw/OpfsPluginStore';
import { FakeDirectoryHandle } from '../../sw/__tests__/fakeOpfs';
import type { Action } from '../../coordinator/actions';

// Magic + version. Per `WebAssembly.validate`, this 8-byte module is valid.
const MIN_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function makeStore(): OpfsPluginStore {
  const root = new FakeDirectoryHandle('plugins');
  return new OpfsPluginStore(root as unknown as FileSystemDirectoryHandle);
}

function buildZip(entries: Record<string, string | Uint8Array>): Uint8Array {
  const out: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(entries)) {
    out[k] = typeof v === 'string' ? new TextEncoder().encode(v) : v;
  }
  return zipSync(out);
}

interface ManifestOverrides {
  id?: string;
  name?: string;
  version?: string;
  kind?: 'gen' | 'fx';
  ui?: { entry: string; width: number; height: number };
}

function manifestJson(overrides: ManifestOverrides = {}): string {
  const base: Record<string, unknown> = {
    id: 'com.example.fuzz',
    name: 'Fuzz',
    version: '1.0.0',
    abi_version: 1,
    kind: 'fx',
    params: [{ name: 'Drive', min: 0, max: 1, default: 0.5 }],
  };
  return JSON.stringify({ ...base, ...overrides });
}

function stubFetch(body: Uint8Array): typeof globalThis.fetch {
  return (async () => {
    const ab = new ArrayBuffer(body.byteLength);
    new Uint8Array(ab).set(body);
    return new Response(ab, { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

async function sha256Base64(bytes: Uint8Array): Promise<string> {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const buf = await crypto.subtle.digest('SHA-256', ab);
  let s = '';
  const arr = new Uint8Array(buf);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]!);
  return btoa(s);
}

describe('PluginInstaller.installFromUrl — happy path', () => {
  it('writes plugin to OPFS and dispatches INSTALL_PLUGIN', async () => {
    const store = makeStore();
    const dispatched: Action[] = [];
    const zip = buildZip({
      'plugin.json': manifestJson(),
      'plugin.wasm': MIN_WASM,
    });
    const installer = new PluginInstaller({
      fetch: stubFetch(zip),
      store,
      dispatch: (a) => dispatched.push(a),
    });
    const r = await installer.installFromUrl('https://example.test/fuzz.noaplugin');
    expect(r).toEqual({
      pluginId: 'com.example.fuzz', version: '1.0.0', name: 'Fuzz', kind: 'fx',
    });
    expect(await store.readFile('com.example.fuzz', '1.0.0', 'plugin.wasm')).not.toBeNull();
    expect(dispatched).toEqual([{ type: 'INSTALL_PLUGIN', entry: r }]);
  });

  it('writes UI files when manifest declares a ui entry', async () => {
    const store = makeStore();
    const zip = buildZip({
      'plugin.json': manifestJson({ ui: { entry: 'index.html', width: 200, height: 100 } }),
      'plugin.wasm': MIN_WASM,
      'ui/index.html': '<html></html>',
      'ui/style.css': 'body{}',
    });
    const installer = new PluginInstaller({
      fetch: stubFetch(zip), store, dispatch: () => {},
    });
    await installer.installFromUrl('https://example.test/fuzz.noaplugin');
    expect(await store.readFile('com.example.fuzz', '1.0.0', 'ui/index.html')).not.toBeNull();
    expect(await store.readFile('com.example.fuzz', '1.0.0', 'ui/style.css')).not.toBeNull();
  });
});

describe('PluginInstaller.installFromUrl — SRI', () => {
  it('passes when the URL fragment matches the body hash', async () => {
    const zip = buildZip({ 'plugin.json': manifestJson(), 'plugin.wasm': MIN_WASM });
    const b64 = await sha256Base64(zip);
    const installer = new PluginInstaller({
      fetch: stubFetch(zip), store: makeStore(), dispatch: () => {},
    });
    await expect(installer.installFromUrl(`https://example.test/fuzz.noaplugin#sha256-${b64}`))
      .resolves.toBeDefined();
  });

  it('throws on hash mismatch', async () => {
    const zip = buildZip({ 'plugin.json': manifestJson(), 'plugin.wasm': MIN_WASM });
    const installer = new PluginInstaller({
      fetch: stubFetch(zip), store: makeStore(), dispatch: () => {},
    });
    await expect(installer.installFromUrl('https://example.test/fuzz.noaplugin#sha256-XXXXwrong'))
      .rejects.toThrow(/SRI/i);
  });

  it('ignores an unparseable fragment', async () => {
    const zip = buildZip({ 'plugin.json': manifestJson(), 'plugin.wasm': MIN_WASM });
    const installer = new PluginInstaller({
      fetch: stubFetch(zip), store: makeStore(), dispatch: () => {},
    });
    await expect(installer.installFromUrl('https://example.test/fuzz.noaplugin#anchor'))
      .resolves.toBeDefined();
  });
});

describe('PluginInstaller.uninstall', () => {
  it('removes the plugin from OPFS and dispatches UNINSTALL_PLUGIN', async () => {
    const store = makeStore();
    const dispatched: Action[] = [];
    const installer = new PluginInstaller({
      fetch: stubFetch(buildZip({
        'plugin.json': manifestJson(),
        'plugin.wasm': MIN_WASM,
      })),
      store,
      dispatch: (a) => dispatched.push(a),
    });
    await installer.installFromUrl('https://example.test/fuzz.noaplugin');
    dispatched.length = 0;
    await installer.uninstall('com.example.fuzz');
    expect(await store.readFile('com.example.fuzz', '1.0.0', 'plugin.wasm')).toBeNull();
    expect(dispatched).toEqual([{ type: 'UNINSTALL_PLUGIN', pluginId: 'com.example.fuzz' }]);
  });

  it('still dispatches UNINSTALL_PLUGIN for an unknown plugin', async () => {
    const dispatched: Action[] = [];
    const installer = new PluginInstaller({
      fetch: stubFetch(new Uint8Array(0)),
      store: makeStore(),
      dispatch: (a) => dispatched.push(a),
    });
    await installer.uninstall('com.example.nope');
    expect(dispatched).toEqual([{ type: 'UNINSTALL_PLUGIN', pluginId: 'com.example.nope' }]);
  });
});

describe('PluginInstaller.installFromUrl — validation', () => {
  it('rejects a ZIP missing plugin.json', async () => {
    const zip = buildZip({ 'plugin.wasm': MIN_WASM });
    const installer = new PluginInstaller({
      fetch: stubFetch(zip), store: makeStore(), dispatch: () => {},
    });
    await expect(installer.installFromUrl('https://example.test/x.noaplugin'))
      .rejects.toThrow(/plugin\.json/i);
  });

  it('rejects a ZIP missing plugin.wasm', async () => {
    const zip = buildZip({ 'plugin.json': manifestJson() });
    const installer = new PluginInstaller({
      fetch: stubFetch(zip), store: makeStore(), dispatch: () => {},
    });
    await expect(installer.installFromUrl('https://example.test/x.noaplugin'))
      .rejects.toThrow(/plugin\.wasm/i);
  });

  it('rejects an invalid wasm body', async () => {
    const zip = buildZip({
      'plugin.json': manifestJson(),
      'plugin.wasm': new Uint8Array([1, 2, 3, 4]),
    });
    const installer = new PluginInstaller({
      fetch: stubFetch(zip), store: makeStore(), dispatch: () => {},
    });
    await expect(installer.installFromUrl('https://example.test/x.noaplugin'))
      .rejects.toThrow(/validate/i);
  });

  it('rejects a malformed manifest', async () => {
    const zip = buildZip({
      'plugin.json': '{"id":"oops"}',
      'plugin.wasm': MIN_WASM,
    });
    const installer = new PluginInstaller({
      fetch: stubFetch(zip), store: makeStore(), dispatch: () => {},
    });
    await expect(installer.installFromUrl('https://example.test/x.noaplugin'))
      .rejects.toThrow();
  });

  it('rejects when manifest.ui entry is missing from the ZIP', async () => {
    const zip = buildZip({
      'plugin.json': manifestJson({ ui: { entry: 'index.html', width: 100, height: 100 } }),
      'plugin.wasm': MIN_WASM,
    });
    const installer = new PluginInstaller({
      fetch: stubFetch(zip), store: makeStore(), dispatch: () => {},
    });
    await expect(installer.installFromUrl('https://example.test/x.noaplugin'))
      .rejects.toThrow(/missing from ZIP/i);
  });

  it('rejects file count > 1000', async () => {
    const entries: Record<string, Uint8Array> = {};
    entries['plugin.json'] = new TextEncoder().encode(manifestJson());
    entries['plugin.wasm'] = MIN_WASM;
    for (let i = 0; i < 1010; i++) entries[`extras/f${i}.txt`] = new Uint8Array([0]);
    const zip = zipSync(entries);
    const installer = new PluginInstaller({
      fetch: stubFetch(zip), store: makeStore(), dispatch: () => {},
    });
    await expect(installer.installFromUrl('https://example.test/x.noaplugin'))
      .rejects.toThrow(/too many files/i);
  });

  it('rejects a non-OK fetch response', async () => {
    const fetch404: typeof globalThis.fetch = (async () =>
      new Response(null, { status: 404 })
    ) as unknown as typeof globalThis.fetch;
    const installer = new PluginInstaller({
      fetch: fetch404, store: makeStore(), dispatch: () => {},
    });
    await expect(installer.installFromUrl('https://example.test/x.noaplugin'))
      .rejects.toThrow(/fetch failed/i);
  });
});
