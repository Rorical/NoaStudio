// Builds a PluginRegistry containing the two Phase 3 built-in plugins.
//
// Built-in plugins use folder-named wasm (`sine.wasm`, `gain.wasm`) rather
// than the spec's canonical `plugin.wasm` so Rollup's emitFile, which dedupes
// asset entries by basename, can emit both. ZIP-packaged plugins in Phase 5
// will use `plugin.wasm` inside the archive — the unpacked OPFS path is
// content-addressed and naturally unique.

import { PluginRegistry } from './PluginRegistry';
import { parseManifest } from './PluginManifest';

import sineManifestJson from '../builtin-plugins/sine/plugin.json';
import sineWasmUrl from '../builtin-plugins/sine/sine.wasm?url';
import gainManifestJson from '../builtin-plugins/gain/plugin.json';
import gainWasmUrl from '../builtin-plugins/gain/gain.wasm?url';

async function compile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`bootBuiltins: ${url} failed (${res.status})`);
  return WebAssembly.compileStreaming(res);
}

export async function bootBuiltinRegistry() {
  const registry = new PluginRegistry();
  const [sineModule, gainModule] = await Promise.all([
    compile(sineWasmUrl),
    compile(gainWasmUrl),
  ]);
  registry.install({
    manifest: parseManifest(sineManifestJson),
    module: sineModule,
    uiAssets: new Map(),
  });
  registry.install({
    manifest: parseManifest(gainManifestJson),
    module: gainModule,
    uiAssets: new Map(),
  });
  return registry;
}
