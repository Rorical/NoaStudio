// Builds a PluginRegistry containing the two Phase 3 built-in plugins,
// including their UI HTML preloaded into `uiAssets`. Vite resolves the
// ?url / ?raw / JSON imports at build time.
//
// Built-in plugins use folder-named wasm (`sine.wasm`, `gain.wasm`) rather
// than the spec's canonical `plugin.wasm` to avoid Rollup's basename-keyed
// asset deduplication. ZIP-packaged plugins in Phase 5 will use `plugin.wasm`
// inside the archive — the unpacked OPFS path is content-addressed and
// naturally unique.

import { PluginRegistry } from './PluginRegistry';
import { parseManifest } from './PluginManifest';

import sineManifestJson from '../builtin-plugins/sine/plugin.json';
import sineWasmUrl from '../builtin-plugins/sine/sine.wasm?url';
import sineUiHtml from '../builtin-plugins/sine/ui/index.html?raw';
import gainManifestJson from '../builtin-plugins/gain/plugin.json';
import gainWasmUrl from '../builtin-plugins/gain/gain.wasm?url';
import gainUiHtml from '../builtin-plugins/gain/ui/index.html?raw';

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`bootBuiltins: ${url} failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

function uiAssetsFromHtml(entry, html) {
  const map = new Map();
  map.set(entry, new TextEncoder().encode(html));
  return map;
}

export async function bootBuiltinRegistry() {
  const registry = new PluginRegistry();
  const [sineWasm, gainWasm] = await Promise.all([
    fetchBytes(sineWasmUrl),
    fetchBytes(gainWasmUrl),
  ]);
  const sineManifest = parseManifest(sineManifestJson);
  const gainManifest = parseManifest(gainManifestJson);
  registry.install({
    manifest: sineManifest,
    wasm: sineWasm,
    uiAssets: sineManifest.ui ? uiAssetsFromHtml(sineManifest.ui.entry, sineUiHtml) : new Map(),
  });
  registry.install({
    manifest: gainManifest,
    wasm: gainWasm,
    uiAssets: gainManifest.ui ? uiAssetsFromHtml(gainManifest.ui.entry, gainUiHtml) : new Map(),
  });
  return registry;
}
