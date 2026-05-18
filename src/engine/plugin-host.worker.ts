/// <reference lib="webworker" />
//
// Per-plugin-instance worker entry. The main thread spawns one of these per
// PluginInstance and pipes it through a MessageChannel paired with PluginWorker.
//
// All non-trivial logic lives in PluginWorkerCore so it can be unit-tested in
// Node without spinning up worker_threads.

import { PluginWorkerCore } from './PluginWorkerCore';

const core = new PluginWorkerCore();

// The main thread either talks to this Worker directly via `Worker.postMessage`
// (default global scope target) or via a transferred port. Phase 4 uses the
// direct path; supporting `connect-port` is a future optimization.
self.onmessage = (e: MessageEvent) => {
  core.handle(e.data, (msg) => (self as DedicatedWorkerGlobalScope).postMessage(msg));
};
