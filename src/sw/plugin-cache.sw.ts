/// <reference lib="webworker" />
/**
 * Noa Studio plugin service worker.
 *
 * Thin shell: instantiates an OpfsPluginStore on the `/plugins/` OPFS subdir
 * and a SwCore router, then forwards `fetch` and `message` events to it. All
 * routing logic lives in SwCore so it's testable in Node.
 *
 * URL namespace served: `/_noa/*` (see SwCore for the per-path contract).
 * Any request outside that prefix falls through to the network.
 */
import { OpfsPluginStore } from './OpfsPluginStore';
import { SwCore, type MessageSource } from './SwCore';

declare const self: ServiceWorkerGlobalScope;

// Lazily-initialized so the install handler can fire immediately without
// blocking on OPFS access (which is fine in Chromium SWs but a needless await
// for callers that don't hit /_noa/* yet).
let corePromise: Promise<SwCore> | null = null;

function getCore(): Promise<SwCore> {
  if (!corePromise) {
    corePromise = (async () => {
      const root = await navigator.storage.getDirectory();
      const pluginsRoot = await root.getDirectoryHandle('plugins', { create: true });
      const store = new OpfsPluginStore(pluginsRoot);
      return new SwCore(store);
    })();
  }
  return corePromise;
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e: ExtendableEvent) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e: FetchEvent) => {
  const url = new URL(e.request.url);
  if (!url.pathname.startsWith('/_noa/')) return;
  e.respondWith((async () => {
    const core = await getCore();
    const r = await core.handleFetch(url);
    return r ?? new Response(null, { status: 404 });
  })());
});

self.addEventListener('message', (e: ExtendableMessageEvent) => {
  const source = (e.source ?? undefined) as MessageSource | undefined;
  e.waitUntil((async () => {
    const core = await getCore();
    core.handleMessage(e.data, source);
  })());
});

export {};
