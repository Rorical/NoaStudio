/// <reference lib="webworker" />
// Service Worker placeholder. Real wiring lands in Task 4.
declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e: ExtendableEvent) => {
  e.waitUntil(self.clients.claim());
});

export {};
