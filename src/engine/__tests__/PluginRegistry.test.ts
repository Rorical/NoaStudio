import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PluginRegistry } from '../PluginRegistry';
import { parseManifest, type PluginManifest } from '../PluginManifest';

let module: WebAssembly.Module;
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
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  module = await WebAssembly.compile(ab);
});

describe('PluginRegistry', () => {
  it('registers and retrieves an entry', () => {
    const reg = new PluginRegistry();
    reg.install({ manifest, module, uiAssets: new Map() });
    expect(reg.has('com.noa.test')).toBe(true);
    expect(reg.get('com.noa.test').manifest.name).toBe('Test');
    expect(reg.list()).toHaveLength(1);
  });

  it('rejects duplicate ids', () => {
    const reg = new PluginRegistry();
    reg.install({ manifest, module, uiAssets: new Map() });
    expect(() => reg.install({ manifest, module, uiAssets: new Map() })).toThrow(/already installed/);
  });

  it('get throws on unknown id', () => {
    const reg = new PluginRegistry();
    expect(() => reg.get('com.unknown.x')).toThrow(/not installed/);
  });

  it('list returns entries in insertion order', () => {
    const reg = new PluginRegistry();
    const m2 = parseManifest({ ...manifest, id: 'com.noa.b' });
    const m3 = parseManifest({ ...manifest, id: 'com.noa.a' });
    reg.install({ manifest: m2, module, uiAssets: new Map() });
    reg.install({ manifest: m3, module, uiAssets: new Map() });
    expect(reg.list().map((e) => e.manifest.id)).toEqual(['com.noa.b', 'com.noa.a']);
  });
});
