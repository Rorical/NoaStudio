import { describe, it, expect } from 'vitest';
import { OpfsPluginStore } from '../OpfsPluginStore';
import { FakeDirectoryHandle } from './fakeOpfs';

function makeRoot(): FakeDirectoryHandle {
  return new FakeDirectoryHandle('plugins');
}

function makeFiles(entries: Record<string, string | Uint8Array>): Map<string, Uint8Array> {
  const m = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(entries)) {
    m.set(k, typeof v === 'string' ? new TextEncoder().encode(v) : v);
  }
  return m;
}

describe('OpfsPluginStore.install', () => {
  it('writes nested files under <pluginId>/<version>/', async () => {
    const root = makeRoot();
    // Cast to unknown then to the spec type for the constructor.
    const store = new OpfsPluginStore(root as unknown as FileSystemDirectoryHandle);
    await store.install({
      pluginId: 'com.noa.sine',
      version: '1.0.0',
      files: makeFiles({
        'plugin.json': '{"id":"com.noa.sine"}',
        'plugin.wasm': new Uint8Array([0, 0x61, 0x73, 0x6d]),
        'ui/index.html': '<html></html>',
        'ui/style/main.css': 'body{}',
      }),
    });
    const wasm = await store.readFile('com.noa.sine', '1.0.0', 'plugin.wasm');
    expect(Array.from(wasm!)).toEqual([0, 0x61, 0x73, 0x6d]);
    const css = await store.readFile('com.noa.sine', '1.0.0', 'ui/style/main.css');
    expect(new TextDecoder().decode(css!)).toBe('body{}');
  });

  it('returns null for files that do not exist', async () => {
    const root = makeRoot();
    const store = new OpfsPluginStore(root as unknown as FileSystemDirectoryHandle);
    const r = await store.readFile('com.noa.missing', '1.0.0', 'plugin.wasm');
    expect(r).toBeNull();
  });

  it('overwrites prior install of the same pluginId+version', async () => {
    const root = makeRoot();
    const store = new OpfsPluginStore(root as unknown as FileSystemDirectoryHandle);
    await store.install({
      pluginId: 'com.noa.x', version: '1.0.0',
      files: makeFiles({ 'plugin.json': 'v1' }),
    });
    await store.install({
      pluginId: 'com.noa.x', version: '1.0.0',
      files: makeFiles({ 'plugin.json': 'v2' }),
    });
    const r = await store.readFile('com.noa.x', '1.0.0', 'plugin.json');
    expect(new TextDecoder().decode(r!)).toBe('v2');
  });

  it('rejects file paths with ".." traversal', async () => {
    const root = makeRoot();
    const store = new OpfsPluginStore(root as unknown as FileSystemDirectoryHandle);
    await expect(store.install({
      pluginId: 'com.noa.bad', version: '1.0.0',
      files: makeFiles({ '../escape.txt': 'oops' }),
    })).rejects.toThrow(/unsafe path/i);
    await expect(store.install({
      pluginId: 'com.noa.bad', version: '1.0.0',
      files: makeFiles({ 'a/../b': 'oops' }),
    })).rejects.toThrow(/unsafe path/i);
  });

  it('rejects file paths starting with /', async () => {
    const root = makeRoot();
    const store = new OpfsPluginStore(root as unknown as FileSystemDirectoryHandle);
    await expect(store.install({
      pluginId: 'com.noa.bad', version: '1.0.0',
      files: makeFiles({ '/abs/path': 'oops' }),
    })).rejects.toThrow(/unsafe path/i);
  });
});

describe('OpfsPluginStore.list', () => {
  it('enumerates installed pluginId+version pairs', async () => {
    const root = makeRoot();
    const store = new OpfsPluginStore(root as unknown as FileSystemDirectoryHandle);
    await store.install({
      pluginId: 'com.noa.a', version: '1.0.0',
      files: makeFiles({ 'plugin.json': '{}' }),
    });
    await store.install({
      pluginId: 'com.noa.b', version: '2.1.0',
      files: makeFiles({ 'plugin.json': '{}' }),
    });
    const list = await store.list();
    expect(list).toContainEqual({ pluginId: 'com.noa.a', version: '1.0.0' });
    expect(list).toContainEqual({ pluginId: 'com.noa.b', version: '2.1.0' });
    expect(list).toHaveLength(2);
  });

  it('returns empty on a fresh store', async () => {
    const root = makeRoot();
    const store = new OpfsPluginStore(root as unknown as FileSystemDirectoryHandle);
    const list = await store.list();
    expect(list).toEqual([]);
  });
});

describe('OpfsPluginStore.remove', () => {
  it('deletes the version directory and subsequent reads return null', async () => {
    const root = makeRoot();
    const store = new OpfsPluginStore(root as unknown as FileSystemDirectoryHandle);
    await store.install({
      pluginId: 'com.noa.gone', version: '1.0.0',
      files: makeFiles({ 'plugin.json': 'x', 'ui/index.html': 'y' }),
    });
    await store.remove('com.noa.gone', '1.0.0');
    const r = await store.readFile('com.noa.gone', '1.0.0', 'plugin.json');
    expect(r).toBeNull();
    const list = await store.list();
    expect(list).toEqual([]);
  });

  it('is a no-op for an unknown pluginId', async () => {
    const root = makeRoot();
    const store = new OpfsPluginStore(root as unknown as FileSystemDirectoryHandle);
    await expect(store.remove('com.noa.nope', '1.0.0')).resolves.toBeUndefined();
  });
});

describe('OpfsPluginStore.readFile path safety', () => {
  it('rejects relative-escape paths on read', async () => {
    const root = makeRoot();
    const store = new OpfsPluginStore(root as unknown as FileSystemDirectoryHandle);
    await expect(store.readFile('com.noa.x', '1.0.0', '../escape'))
      .rejects.toThrow(/unsafe path/i);
  });
});
