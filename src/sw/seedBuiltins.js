/**
 * First-boot seed: copy the two bundled built-in plugins into OPFS so the
 * Service Worker can serve them via /_noa/plugins/<id>/<version>/*. Idempotent
 * — a non-empty store is left untouched, so re-running on subsequent boots is
 * a cheap `list()` call.
 *
 * Vite resolves the JSON / ?url / ?raw imports at build time; we fetch the
 * wasm bytes at runtime and lay everything out under the spec's canonical
 * filenames inside OPFS (the bundled artifacts use folder-named wasm to
 * dodge Rollup's basename collision, but OPFS doesn't share that namespace).
 */
import sineManifestJson from '../builtin-plugins/sine/plugin.json';
import sineWasmUrl from '../builtin-plugins/sine/sine.wasm?url';
import sineUiHtml from '../builtin-plugins/sine/ui/index.html?raw';
import gainManifestJson from '../builtin-plugins/gain/plugin.json';
import gainWasmUrl from '../builtin-plugins/gain/gain.wasm?url';
import gainUiHtml from '../builtin-plugins/gain/ui/index.html?raw';

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`seedBuiltins: ${url} failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

async function bundleFiles(manifestJson, wasmUrl, uiHtml) {
  const enc = new TextEncoder();
  const files = new Map();
  files.set('plugin.json', enc.encode(JSON.stringify(manifestJson)));
  files.set('plugin.wasm', await fetchBytes(wasmUrl));
  if (manifestJson.ui?.entry) {
    files.set('ui/' + manifestJson.ui.entry, enc.encode(uiHtml));
  }
  return files;
}

export async function seedBuiltins(store) {
  const existing = await store.list();
  if (existing.length > 0) return;
  await store.install({
    pluginId: sineManifestJson.id,
    version: sineManifestJson.version,
    files: await bundleFiles(sineManifestJson, sineWasmUrl, sineUiHtml),
  });
  await store.install({
    pluginId: gainManifestJson.id,
    version: gainManifestJson.version,
    files: await bundleFiles(gainManifestJson, gainWasmUrl, gainUiHtml),
  });
}
