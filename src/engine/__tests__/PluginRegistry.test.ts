import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PluginRegistry } from '../PluginRegistry';
import { parseManifest, type PluginManifest } from '../PluginManifest';

let wasm: Uint8Array;
const manifest: PluginManifest = parseManifest({
  id: 'com.noa.test',
  name: 'Test',
  version: '0.0.1',
  abi_version: 1,
  kind: 'fx',
  params: [{ name: 'Volume', min: 0, max: 2, default: 1 }],
});

beforeAll(async () => {
  const buf = await readFile(path.resolve('src/engine/__tests__/fixtures/test-plugin/plugin.wasm'));
  wasm = new Uint8Array(buf.byteLength);
  wasm.set(buf);
});

describe('PluginRegistry', () => {
  it('registers and retrieves an entry', () => {
    const reg = new PluginRegistry();
    reg.install({ manifest, wasm, uiAssets: new Map() });
    expect(reg.has('com.noa.test')).toBe(true);
    expect(reg.get('com.noa.test').manifest.name).toBe('Test');
    expect(reg.list()).toHaveLength(1);
  });

  it('rejects duplicate ids', () => {
    const reg = new PluginRegistry();
    reg.install({ manifest, wasm, uiAssets: new Map() });
    expect(() => reg.install({ manifest, wasm, uiAssets: new Map() })).toThrow(/already installed/);
  });

  it('get throws on unknown id', () => {
    const reg = new PluginRegistry();
    expect(() => reg.get('com.unknown.x')).toThrow(/not installed/);
  });

  it('list returns entries in insertion order', () => {
    const reg = new PluginRegistry();
    const m2 = parseManifest({ ...manifest, id: 'com.noa.b' });
    const m3 = parseManifest({ ...manifest, id: 'com.noa.a' });
    reg.install({ manifest: m2, wasm, uiAssets: new Map() });
    reg.install({ manifest: m3, wasm, uiAssets: new Map() });
    expect(reg.list().map((e) => e.manifest.id)).toEqual(['com.noa.b', 'com.noa.a']);
  });
});

describe('PluginRegistry.loadFromOpfsViaSw', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function jsonResponse(body: unknown, ok = true): Response {
    return new Response(JSON.stringify(body), {
      status: ok ? 200 : 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function wasmResponse(bytes: Uint8Array, ok = true): Response {
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    return new Response(ab, {
      status: ok ? 200 : 404,
      headers: { 'Content-Type': 'application/wasm' },
    });
  }

  function htmlResponse(): Response {
    // Simulates the SPA fallback when the SW isn't intercepting.
    return new Response('<!doctype html><html></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  it('happy path: fetches manifest + wasm and returns a registry entry', async () => {
    const manifestJson = {
      id: 'com.noa.test', name: 'Test', version: '0.0.1', abi_version: 1, kind: 'fx',
      params: [{ name: 'Volume', min: 0, max: 2, default: 1 }],
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/manifest')) return jsonResponse(manifestJson);
      if (u.endsWith('/wasm')) return wasmResponse(wasm);
      return new Response(null, { status: 404 });
    });
    const entry = await PluginRegistry.loadFromOpfsViaSw('com.noa.test', '0.0.1');
    expect(entry.manifest.id).toBe('com.noa.test');
    expect(entry.wasm.byteLength).toBe(wasm.byteLength);
    expect(entry.uiAssets.size).toBe(0); // not preloaded — SW serves on demand
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls).toContain('/_noa/plugins/com.noa.test/0.0.1/manifest');
    expect(calls).toContain('/_noa/plugins/com.noa.test/0.0.1/wasm');
  });

  it('URL-encodes pluginId + version', async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      seen.push(String(url));
      const u = String(url);
      if (u.endsWith('/manifest')) {
        return jsonResponse({
          id: 'com/weird', name: 'X', version: '1.0/beta', abi_version: 1, kind: 'fx',
          params: [{ name: 'A', min: 0, max: 1, default: 0 }],
        });
      }
      return wasmResponse(wasm);
    });
    await PluginRegistry.loadFromOpfsViaSw('com/weird', '1.0/beta').catch(() => undefined);
    expect(seen[0]).toContain('com%2Fweird');
    expect(seen[0]).toContain('1.0%2Fbeta');
  });

  it('rejects when the manifest fetch returns non-OK', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(null, { status: 404 }),
    );
    await expect(
      PluginRegistry.loadFromOpfsViaSw('com.noa.missing', '1.0.0'),
    ).rejects.toThrow(/manifest fetch failed \(404\)/);
  });

  it('rejects when the manifest response is HTML (SW probably not active)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => htmlResponse());
    await expect(
      PluginRegistry.loadFromOpfsViaSw('com.noa.test', '0.0.1'),
    ).rejects.toThrow(/unexpected Content-Type 'text\/html/);
  });

  it('rejects when the manifest is invalid', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/manifest')) return jsonResponse({ id: 'incomplete' });
      return wasmResponse(wasm);
    });
    await expect(
      PluginRegistry.loadFromOpfsViaSw('com.noa.test', '0.0.1'),
    ).rejects.toThrow();
  });

  it('rejects when the wasm fetch returns non-OK', async () => {
    const manifestJson = {
      id: 'com.noa.test', name: 'Test', version: '0.0.1', abi_version: 1, kind: 'fx',
      params: [{ name: 'Volume', min: 0, max: 2, default: 1 }],
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/manifest')) return jsonResponse(manifestJson);
      return new Response(null, { status: 500 });
    });
    await expect(
      PluginRegistry.loadFromOpfsViaSw('com.noa.test', '0.0.1'),
    ).rejects.toThrow(/wasm fetch failed \(500\)/);
  });
});
