/**
 * Platform-agnostic router for the Noa plugin service worker.
 *
 * The SW shell (`plugin-cache.sw.ts`) wires `fetch` and `message` events to a
 * SwCore instance. All routing logic lives here so it's testable in Node
 * against a fake OPFS store.
 *
 * URL namespace (everything under `/_noa/`):
 *   /_noa/plugins/<pluginId>/<version>/wasm       → plugin.wasm bytes
 *   /_noa/plugins/<pluginId>/<version>/manifest   → plugin.json
 *   /_noa/plugin-ui/<instanceId>/<subpath>        → ui/<subpath> for the
 *                                                    plugin currently bound to
 *                                                    <instanceId>
 *
 * Message protocol (over the SW's `postMessage` port):
 *   { type: 'BIND_INSTANCE', instanceId, pluginId, version }
 *   { type: 'UNBIND_INSTANCE', instanceId }
 *   { type: 'INVALIDATE_PLUGIN', pluginId, version }   // currently a no-op
 *   { type: 'PING' }                                   // replies { type: 'PONG' }
 */

import type { OpfsPluginStore } from './OpfsPluginStore';
import { injectBootstrap } from '../engine/pluginUiBootstrap';

export interface MessageSource {
  postMessage(data: unknown): void;
}

interface Binding {
  pluginId: string;
  version: string;
}

const COMMON_HEADERS: Record<string, string> = {
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

function contentTypeFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.wasm')) return 'application/wasm';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html; charset=utf-8';
  if (lower.endsWith('.css')) return 'text/css; charset=utf-8';
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.woff2')) return 'font/woff2';
  if (lower.endsWith('.woff')) return 'font/woff';
  if (lower.endsWith('.ttf')) return 'font/ttf';
  return 'application/octet-stream';
}

function isSafeId(s: unknown): s is string {
  return typeof s === 'string'
    && s.length > 0
    && !s.includes('/')
    && !s.includes('\\')
    && !s.includes('..')
    && s !== '.'
    && s !== '..';
}

function notFound(): Response {
  return new Response(null, { status: 404, headers: COMMON_HEADERS });
}

/**
 * Force an ArrayBuffer-backed copy so TypeScript's BodyInit accepts it under
 * the strict Uint8Array<ArrayBufferLike> typing — and so a SharedArrayBuffer-
 * backed view (theoretically possible from OPFS) wouldn't trip Response.
 */
function toBody(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

export class SwCore {
  private bindings = new Map<string, Binding>();

  constructor(private readonly store: OpfsPluginStore) {}

  handleMessage(data: unknown, source?: MessageSource): void {
    if (!data || typeof data !== 'object') return;
    const msg = data as { type?: unknown };
    switch (msg.type) {
      case 'BIND_INSTANCE': {
        const m = data as { instanceId?: unknown; pluginId?: unknown; version?: unknown };
        if (!isSafeId(m.instanceId) || !isSafeId(m.pluginId) || !isSafeId(m.version)) return;
        this.bindings.set(m.instanceId, { pluginId: m.pluginId, version: m.version });
        return;
      }
      case 'UNBIND_INSTANCE': {
        const m = data as { instanceId?: unknown };
        if (typeof m.instanceId !== 'string') return;
        this.bindings.delete(m.instanceId);
        return;
      }
      case 'INVALIDATE_PLUGIN': {
        // No cache to invalidate yet — every fetch re-reads from OPFS.
        return;
      }
      case 'PING': {
        source?.postMessage({ type: 'PONG' });
        return;
      }
    }
  }

  async handleFetch(url: URL): Promise<Response | null> {
    if (!url.pathname.startsWith('/_noa/')) return null;
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] !== '_noa') return null;

    if (segments[1] === 'plugins') {
      return this.handlePluginFetch(segments);
    }
    if (segments[1] === 'plugin-ui') {
      return this.handleUiFetch(segments);
    }
    return null;
  }

  private async handlePluginFetch(segments: string[]): Promise<Response> {
    if (segments.length !== 5) return notFound();
    const pluginId = segments[2]!;
    const version = segments[3]!;
    const kind = segments[4]!;
    if (!isSafeId(pluginId) || !isSafeId(version)) return notFound();

    if (kind === 'wasm') {
      const bytes = await this.store.readFile(pluginId, version, 'plugin.wasm');
      if (!bytes) return notFound();
      return new Response(toBody(bytes), {
        status: 200,
        headers: { ...COMMON_HEADERS, 'Content-Type': 'application/wasm' },
      });
    }
    if (kind === 'manifest') {
      const bytes = await this.store.readFile(pluginId, version, 'plugin.json');
      if (!bytes) return notFound();
      return new Response(toBody(bytes), {
        status: 200,
        headers: {
          ...COMMON_HEADERS,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
      });
    }
    return notFound();
  }

  private async handleUiFetch(segments: string[]): Promise<Response> {
    if (segments.length < 4) return notFound();
    const instanceId = segments[2]!;
    if (!isSafeId(instanceId)) return notFound();
    const binding = this.bindings.get(instanceId);
    if (!binding) return notFound();

    const tail = segments.slice(3);
    if (tail.some((s) => s === '..' || s === '.')) return notFound();
    const relPath = tail.join('/');
    if (!relPath) return notFound();

    const bytes = await this.store.readFile(binding.pluginId, binding.version, 'ui/' + relPath);
    if (!bytes) return notFound();
    const contentType = contentTypeFor(relPath);
    // HTML entries get the plugin-UI bootstrap injected so they can talk to
    // the host via window.__noa without bundling the protocol themselves.
    const body = contentType.startsWith('text/html')
      ? new TextEncoder().encode(injectBootstrap(new TextDecoder().decode(bytes)))
      : bytes;
    return new Response(toBody(body), {
      status: 200,
      headers: { ...COMMON_HEADERS, 'Content-Type': contentType },
    });
  }
}
