import { ClientBridge } from './ClientBridge';

let bridge = null;
let connecting = false;

export function getCoordinator() {
  if (bridge) return bridge;
  if (!connecting) {
    connecting = true;
    const workerUrl = import.meta.env.DEV
      ? new URL('./coordinator.worker.ts', import.meta.url)
      : new URL('/coordinator-worker.js', window.location.origin);
    const sw = new SharedWorker(workerUrl, { type: 'module', name: 'noa-coordinator' });
    bridge = new ClientBridge(sw.port);
    bridge.connect();
  }
  return bridge;
}
