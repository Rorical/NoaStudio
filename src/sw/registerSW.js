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
  // Module SW in both dev and prod: Vite emits ESM with `import` statements
  // for the production bundle too (its `?worker` output keeps the module
  // graph), so classic-script registration trips on "Cannot use import
  // statement outside a module".
  try {
    const reg = await navigator.serviceWorker.register('/plugin-cache-sw.js', {
      scope: '/', type: 'module',
    });
    await navigator.serviceWorker.ready;
    return reg;
  } catch (err) {
    console.warn('[noa] SW registration failed; falling back to Blob URLs:', err);
    return null;
  }
}
