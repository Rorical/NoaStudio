/**
 * Main-thread Service Worker registration for the plugin cache SW.
 *
 * Returns a promise of the active ServiceWorkerRegistration, or `null` when
 * the browser doesn't support SWs or registration fails. Callers that need
 * the SW for plugin asset delivery should await this and gracefully fall back
 * to Blob URLs when it resolves null.
 */
export async function registerSW() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }
  // Dev: Vite serves the SW as transformed TS with ESM imports, which needs
  // a module-type SW. Production: Rollup bundles a single classic script.
  const opts = import.meta.env.DEV
    ? { scope: '/', type: 'module' }
    : { scope: '/' };
  try {
    const reg = await navigator.serviceWorker.register('/plugin-cache-sw.js', opts);
    await navigator.serviceWorker.ready;
    return reg;
  } catch (err) {
    console.warn('[noa] SW registration failed; falling back to Blob URLs:', err);
    return null;
  }
}
