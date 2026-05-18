import { describe, it, expect } from 'vitest';
import { SwCore } from '../SwCore';
import { OpfsPluginStore } from '../OpfsPluginStore';
import { FakeDirectoryHandle } from './fakeOpfs';

function makeStore(): OpfsPluginStore {
  const root = new FakeDirectoryHandle('plugins');
  return new OpfsPluginStore(root as unknown as FileSystemDirectoryHandle);
}

function makeFiles(entries: Record<string, string | Uint8Array>): Map<string, Uint8Array> {
  const m = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(entries)) {
    m.set(k, typeof v === 'string' ? new TextEncoder().encode(v) : v);
  }
  return m;
}

describe('SwCore.handleFetch namespace gating', () => {
  it('returns null for URLs outside /_noa/', async () => {
    const core = new SwCore(makeStore());
    expect(await core.handleFetch(new URL('https://app.test/index.html'))).toBeNull();
    expect(await core.handleFetch(new URL('https://app.test/api/foo'))).toBeNull();
    expect(await core.handleFetch(new URL('https://app.test/_noatypo/x'))).toBeNull();
  });
});

describe('SwCore.handleFetch plugin wasm', () => {
  it('serves the plugin wasm with application/wasm + CORP', async () => {
    const store = makeStore();
    await store.install({
      pluginId: 'com.noa.sine', version: '1.0.0',
      files: makeFiles({ 'plugin.wasm': new Uint8Array([0, 0x61, 0x73, 0x6d]) }),
    });
    const core = new SwCore(store);
    const r = await core.handleFetch(new URL('https://app.test/_noa/plugins/com.noa.sine/1.0.0/wasm'));
    expect(r).not.toBeNull();
    expect(r!.status).toBe(200);
    expect(r!.headers.get('Content-Type')).toBe('application/wasm');
    expect(r!.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(r!.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    const buf = new Uint8Array(await r!.arrayBuffer());
    expect(Array.from(buf)).toEqual([0, 0x61, 0x73, 0x6d]);
  });

  it('returns 404 if the wasm is missing', async () => {
    const core = new SwCore(makeStore());
    const r = await core.handleFetch(new URL('https://app.test/_noa/plugins/com.noa.missing/1.0.0/wasm'));
    expect(r).not.toBeNull();
    expect(r!.status).toBe(404);
  });
});

describe('SwCore.handleFetch plugin manifest', () => {
  it('serves the manifest as JSON with Cache-Control: no-store', async () => {
    const store = makeStore();
    await store.install({
      pluginId: 'com.noa.sine', version: '1.0.0',
      files: makeFiles({ 'plugin.json': '{"id":"com.noa.sine"}' }),
    });
    const core = new SwCore(store);
    const r = await core.handleFetch(new URL('https://app.test/_noa/plugins/com.noa.sine/1.0.0/manifest'));
    expect(r!.status).toBe(200);
    expect(r!.headers.get('Content-Type')).toBe('application/json');
    expect(r!.headers.get('Cache-Control')).toBe('no-store');
    expect(await r!.text()).toBe('{"id":"com.noa.sine"}');
  });

  it('404s for an unknown manifest', async () => {
    const core = new SwCore(makeStore());
    const r = await core.handleFetch(new URL('https://app.test/_noa/plugins/none/1.0.0/manifest'));
    expect(r!.status).toBe(404);
  });
});

describe('SwCore.handleFetch malformed plugin URLs', () => {
  it('404s on unknown trailing segment', async () => {
    const core = new SwCore(makeStore());
    const r = await core.handleFetch(new URL('https://app.test/_noa/plugins/a/1.0.0/random'));
    expect(r!.status).toBe(404);
  });

  it('404s on missing version', async () => {
    const core = new SwCore(makeStore());
    const r = await core.handleFetch(new URL('https://app.test/_noa/plugins/a/wasm'));
    expect(r!.status).toBe(404);
  });
});

describe('SwCore plugin-ui (instance-scoped)', () => {
  it('serves UI files bound to an instance', async () => {
    const store = makeStore();
    await store.install({
      pluginId: 'com.noa.sine', version: '1.0.0',
      files: makeFiles({
        'ui/index.html': '<html></html>',
        'ui/style/main.css': 'body{}',
        'ui/logo.svg': '<svg/>',
      }),
    });
    const core = new SwCore(store);
    core.handleMessage({
      type: 'BIND_INSTANCE', instanceId: 'inst-1',
      pluginId: 'com.noa.sine', version: '1.0.0',
    });

    const html = await core.handleFetch(new URL('https://app.test/_noa/plugin-ui/inst-1/index.html'));
    expect(html!.status).toBe(200);
    expect(html!.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    // HTML responses get the bootstrap prepended; original content is preserved.
    const body = await html!.text();
    expect(body).toContain('<html></html>');

    const css = await core.handleFetch(new URL('https://app.test/_noa/plugin-ui/inst-1/style/main.css'));
    expect(css!.status).toBe(200);
    expect(css!.headers.get('Content-Type')).toBe('text/css; charset=utf-8');
    expect(await css!.text()).toBe('body{}');

    const svg = await core.handleFetch(new URL('https://app.test/_noa/plugin-ui/inst-1/logo.svg'));
    expect(svg!.headers.get('Content-Type')).toBe('image/svg+xml');
  });

  it('injects the plugin-UI bootstrap into HTML responses', async () => {
    const store = makeStore();
    await store.install({
      pluginId: 'com.noa.sine', version: '1.0.0',
      files: makeFiles({
        'ui/index.html': '<html><head></head><body>x</body></html>',
        'ui/style.css': 'body{}',
      }),
    });
    const core = new SwCore(store);
    core.handleMessage({ type: 'BIND_INSTANCE', instanceId: 'i', pluginId: 'com.noa.sine', version: '1.0.0' });
    const html = await core.handleFetch(new URL('https://app.test/_noa/plugin-ui/i/index.html'));
    const body = await html!.text();
    expect(body).toContain('window.__noa');
    expect(body).toContain('<body>x</body>');
    // CSS responses are passed through untouched.
    const css = await core.handleFetch(new URL('https://app.test/_noa/plugin-ui/i/style.css'));
    expect(await css!.text()).toBe('body{}');
  });

  it('returns 404 for an unbound instance', async () => {
    const core = new SwCore(makeStore());
    const r = await core.handleFetch(new URL('https://app.test/_noa/plugin-ui/inst-x/index.html'));
    expect(r!.status).toBe(404);
  });

  it('returns 404 after UNBIND_INSTANCE', async () => {
    const store = makeStore();
    await store.install({
      pluginId: 'com.noa.sine', version: '1.0.0',
      files: makeFiles({ 'ui/index.html': '<html></html>' }),
    });
    const core = new SwCore(store);
    core.handleMessage({ type: 'BIND_INSTANCE', instanceId: 'i', pluginId: 'com.noa.sine', version: '1.0.0' });
    core.handleMessage({ type: 'UNBIND_INSTANCE', instanceId: 'i' });
    const r = await core.handleFetch(new URL('https://app.test/_noa/plugin-ui/i/index.html'));
    expect(r!.status).toBe(404);
  });

  it('returns 404 for an empty UI subpath', async () => {
    const store = makeStore();
    await store.install({ pluginId: 'p', version: '1', files: makeFiles({ 'plugin.json': '{}' }) });
    const core = new SwCore(store);
    core.handleMessage({ type: 'BIND_INSTANCE', instanceId: 'i', pluginId: 'p', version: '1' });
    const r = await core.handleFetch(new URL('https://app.test/_noa/plugin-ui/i'));
    expect(r!.status).toBe(404);
  });
});

describe('SwCore.handleMessage robustness', () => {
  it('ignores BIND_INSTANCE with missing fields', () => {
    const core = new SwCore(makeStore());
    core.handleMessage({ type: 'BIND_INSTANCE' });
    core.handleMessage({ type: 'BIND_INSTANCE', instanceId: 'i' });
    core.handleMessage({ type: 'BIND_INSTANCE', instanceId: 'i', pluginId: 'p' });
    // No throws; nothing is bound.
  });

  it('ignores BIND_INSTANCE with unsafe ids', () => {
    const core = new SwCore(makeStore());
    core.handleMessage({ type: 'BIND_INSTANCE', instanceId: '../escape', pluginId: 'p', version: '1' });
    core.handleMessage({ type: 'BIND_INSTANCE', instanceId: 'i', pluginId: '../p', version: '1' });
    core.handleMessage({ type: 'BIND_INSTANCE', instanceId: 'i', pluginId: 'p', version: 'a/b' });
  });

  it('ignores unknown message types and non-object payloads', () => {
    const core = new SwCore(makeStore());
    core.handleMessage(null);
    core.handleMessage(undefined);
    core.handleMessage('hi');
    core.handleMessage({ type: 'WHATEVER' });
  });

  it('PING replies with PONG to the source', () => {
    const core = new SwCore(makeStore());
    const messages: unknown[] = [];
    const source = { postMessage: (m: unknown) => messages.push(m) };
    core.handleMessage({ type: 'PING' }, source);
    expect(messages).toEqual([{ type: 'PONG' }]);
  });

  it('INVALIDATE_PLUGIN is accepted (no-op for now)', () => {
    const core = new SwCore(makeStore());
    core.handleMessage({ type: 'INVALIDATE_PLUGIN', pluginId: 'p', version: '1' });
  });
});
