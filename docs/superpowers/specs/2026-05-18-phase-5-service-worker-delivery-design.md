# Phase 5: Service Worker Delivery — Design Spec

**Status:** Design locked. Plan: `docs/superpowers/plans/2026-05-18-phase-5-service-worker-delivery.md`.

**Predecessors:** Phase 4 (per-instance worker + ABI v1.1 preset hot-swap) shipped. The audio path runs through WASM plugins via a per-instance worker; floating UIs are hosted in sandboxed iframes built from in-memory Blob URLs.

**This phase replaces the Blob-URL UI scheme with a real HTTP namespace served by a Service Worker out of OPFS, and adds a `.noaplugin` ZIP install flow so users can drop plugins onto the canvas from a URL.**

---

## 1. Goal

End-of-phase demo:

1. Open Noa. The two built-ins (`com.noa.sine`, `com.noa.gain`) load through the SW URL namespace; their floating UIs are served from `/_noa/plugin-ui/<instanceId>/index.html`. Audio works.
2. In the Browser pane, click "Install plugin from URL…" and paste a URL pointing at a `.noaplugin` ZIP. The Browser fetches it, verifies a Subresource-Integrity hash, unzips into OPFS, and the plugin appears in the Browser's plugin list.
3. Drag the new plugin onto a track or FX rack. It instantiates, audio reflects the change.
4. Disable network in DevTools. Reload. The page boots offline, the installed plugin is still there, its UI assets (HTML + CSS + custom font) serve from OPFS via the SW with no network requests, and audio still plays.

Multi-file UI bundles (HTML referencing external CSS, fonts, dynamic `import()`s) work because the iframe loads from a real same-origin URL instead of a Blob.

---

## 2. Out of scope (deferred)

- **Per-instance UI state isolation beyond the URL scheme.** The SW gives each iframe instance a distinct URL so `window` is fresh; persisting state across reloads is still on the plugin author.
- **Project-asset URL space (`/_noa/project-assets/...`).** Defined in the roadmap; not implemented in v1.
- **Plugin permissions model (filesystem / MIDI / network).** All installed plugins are trusted in v1.
- **Automatic updates and version negotiation.** v1 stores one version per plugin id; reinstall overwrites.
- **App shell offline caching.** Only `/_noa/*` URLs are served from cache. The main HTML / JS bundle is whatever the host serves (Vite dev or static hosting).
- **Curated registry / marketplace.** v1 is "paste any URL."
- **Update strategy.** Reinstall = delete + install fresh; no incremental updates.

---

## 3. Architecture

```
Main thread                         Service Worker                       OPFS
───────────                         ──────────────                       ────
PluginInstaller                                                           /plugins/<id>/<version>/
  install(url) ───fetch───▶ .noaplugin ZIP
              ───unzip via fflate───▶ writes ──────────────────────────▶ plugin.wasm
                                              ─────────────────────────▶ plugin.json
                                              ─────────────────────────▶ ui/*

InstalledPluginsStore (in coordinator)
  list: [{ id, version, sha256, rootPath, installedAt }]
  persisted via the existing coordinator → OPFS path

PluginUIHost                        SW intercepts /_noa/plugin-ui/<instanceId>/<path>
  openWindow ───register───▶  scope binding: instanceId → {pluginId, version}
              creates an iframe with src="/_noa/plugin-ui/<instanceId>/index.html"
                                                  fetch ──┐
                                                          ▼
                                                       OPFS read → response
                                                       (COEP / CORP headers)
```

Key flows:

- **Boot.** The main thread registers `src/sw/plugin-cache.sw.ts`. The SW reads the coordinator's `InstalledPluginsStore` from OPFS on `install`/`activate`. Built-in plugins are seeded into OPFS on first boot (one-shot copy from the Vite bundle into `/plugins/com.noa.sine/1.0.0/` etc).
- **Open plugin window.** `PluginUIHost.openWindow` posts a `BIND_INSTANCE` message to the SW with `{instanceId, pluginId, version}`. The SW caches the binding in memory. Then it creates an `<iframe src="/_noa/plugin-ui/<instanceId>/index.html">`. The iframe's `fetch`es go through the SW; the SW resolves them against `OPFS:/plugins/<id>/<version>/ui/<path>`. Close → `UNBIND_INSTANCE` clears the binding.
- **Install plugin.** `PluginInstaller.install(url)` fetches the ZIP, verifies its SHA-256 against an integrity hash if provided, runs fflate to unzip into an OPFS staging directory, validates the manifest, atomically renames to `/plugins/<id>/<version>/`, and posts `InstalledPluginsStore.add({...})` to the coordinator. The Browser pane re-renders to show the new plugin.

---

## 4. Service Worker

### 4.1 Registration

`src/main.jsx` (or a new `src/sw/registerSW.js`) calls `navigator.serviceWorker.register('/plugin-cache-sw.js', { scope: '/' })` on app boot. The registration is fire-and-forget: if it fails (e.g., HTTPS not available outside `localhost`), the app falls back to the existing Blob URL path with a console warning.

The SW file is built by Vite as a top-level worker bundle (similar to how `coordinator.worker.ts` and `audio-worklet.ts` are emitted). It registers under the page origin, scope `/`.

### 4.2 URL namespace

| Pattern | Origin | Resolves to | Status |
| --- | --- | --- | --- |
| `/_noa/plugins/<pluginId>/<version>/wasm` | SW | `OPFS:/plugins/<id>/<version>/plugin.wasm` | Phase 5 |
| `/_noa/plugins/<pluginId>/<version>/manifest` | SW | `OPFS:/plugins/<id>/<version>/plugin.json` | Phase 5 |
| `/_noa/plugin-ui/<instanceId>/<path>` | SW | `OPFS:/plugins/<id>/<version>/ui/<path>` (id+version from the instance binding) | Phase 5 |
| `/_noa/project-assets/<projectId>/<path>` | SW | TBD | Deferred |

All responses carry:
- `Cross-Origin-Resource-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp` (already required by the page)
- `Cache-Control: no-store` for the manifest (so the install flow always reads fresh)
- `Cache-Control: immutable, max-age=31536000` for wasm + ui assets (content-addressed by version)

### 4.3 Message protocol (main → SW)

```ts
type SwInbound =
  | { type: 'BIND_INSTANCE'; instanceId: string; pluginId: string; version: string }
  | { type: 'UNBIND_INSTANCE'; instanceId: string }
  | { type: 'INVALIDATE_PLUGIN'; pluginId: string; version: string }
  | { type: 'PING' };
```

The SW does not initiate messages; it only responds to `PING` for liveness checks during install.

---

## 5. `.noaplugin` ZIP format

ZIP archive containing:

```
/plugin.json
/plugin.wasm
/ui/index.html        (optional; required if manifest.ui is present)
/ui/*                 (any additional UI assets — CSS, JS, fonts, images)
```

**Validation rules** (enforced by `PluginInstaller`):

- `plugin.json` MUST be present and parse as a v1 manifest.
- `plugin.wasm` MUST be present and pass `WebAssembly.validate(...)`.
- If `manifest.ui` is set, `ui/<manifest.ui.entry>` MUST be present.
- Total uncompressed size MUST be < 50 MB.
- File count MUST be < 1000.
- No path component MAY contain `..` or start with `/`.

**Integrity:** the install URL may carry a fragment `#sha384-<base64>`. If present, the installer verifies the SRI hash of the entire ZIP body before extraction. Mismatch aborts the install.

---

## 6. OPFS layout

```
opfs:/
├── project.json                      # existing (Phase 2 coordinator)
└── plugins/
    └── <plugin-id>/
        └── <version>/
            ├── plugin.json
            ├── plugin.wasm
            └── ui/
                └── ...
```

Plugin removal: delete the version directory. Plugin update: install side-by-side, atomically switch, garbage-collect old version on next boot.

For v1, only one version per plugin id is kept (reinstall overwrites). Multi-version support arrives later when the engine wires versioned references.

---

## 7. Coordinator integration

`src/coordinator/projectModel.ts` gains:

```ts
interface InstalledPlugin {
  pluginId: string;
  version: string;
  /** Sha-256 of the install ZIP, lowercase hex. Used for cache key + integrity. */
  sha256: string;
  /** ISO 8601. */
  installedAt: string;
  /** OPFS root inside the plugins directory. Always `${pluginId}/${version}`. */
  rootPath: string;
}

interface Project {
  /* ...existing */
  installedPlugins: InstalledPlugin[];
}
```

New actions:

```ts
| { type: 'INSTALL_PLUGIN'; entry: InstalledPlugin }
| { type: 'UNINSTALL_PLUGIN'; pluginId: string }
```

The seed has the two built-ins pre-registered:

```ts
installedPlugins: [
  { pluginId: 'com.noa.sine', version: '1.0.0', sha256: '<sha>', installedAt: '...', rootPath: 'com.noa.sine/1.0.0' },
  { pluginId: 'com.noa.gain', version: '1.0.0', sha256: '<sha>', installedAt: '...', rootPath: 'com.noa.gain/1.0.0' },
]
```

When the SW boots and finds OPFS empty under `/plugins/`, it copies the built-ins from the Vite bundle (which still ships them) into OPFS as a one-shot seed.

---

## 8. PluginInstaller

```ts
// src/engine/PluginInstaller.ts
export class PluginInstaller {
  constructor(args: { coordinator: ClientBridge; opfsRoot: FileSystemDirectoryHandle });

  async installFromUrl(url: string): Promise<InstalledPlugin>;
  async uninstall(pluginId: string): Promise<void>;
  async listInstalled(): Promise<InstalledPlugin[]>;
}
```

`installFromUrl` flow:

1. `fetch(url)` → `arrayBuffer()`.
2. Compute SHA-256 of the bytes via `crypto.subtle.digest('SHA-256', bytes)`.
3. If the URL has a `#sha384-...` fragment, verify; mismatch → throw.
4. Unzip via `fflate.unzipSync(new Uint8Array(bytes))`.
5. Parse `/plugin.json` via `parseManifest`.
6. Validate manifest, total size, file count, paths (Section 5 rules).
7. `WebAssembly.validate(/plugin.wasm bytes)` → throw on invalid.
8. Stage into `opfs:/plugins/<id>.staging-<ts>/` (so a crash doesn't leave a half-installed plugin).
9. Atomic rename via `move` → `opfs:/plugins/<id>/<version>/`.
10. Coordinator dispatch `INSTALL_PLUGIN { entry }`.
11. Return the entry.

---

## 9. PluginUIHost changes

`PluginUIHost.openWindow(args)` no longer reads `uiAssets` directly. Instead:

1. Looks up the plugin's `{pluginId, version}` from the runtime registry.
2. Posts `BIND_INSTANCE {instanceId, pluginId, version}` to the active SW registration (if registered).
3. Creates `<iframe src="/_noa/plugin-ui/<instanceId>/<manifest.ui.entry>" sandbox="allow-scripts allow-same-origin">`.
4. The SW intercepts the iframe's HTML + sub-resource requests and serves from OPFS.
5. Listens for `READY` from the iframe; posts `HELLO` with SAB rings (unchanged from Phase 4).
6. On `close`: posts `UNBIND_INSTANCE`, removes the iframe.

When the SW is **not** registered (fallback), the host keeps the Phase 3 Blob URL path. This is a backwards-compat shim until the SW is solid.

---

## 10. Browser pane updates

`src/components/Browser.jsx`:

- New section header under "Plugins": "Installed" (lists everything from `installedPlugins`).
- "Install plugin from URL…" button at the bottom. Opens a small modal:
  - URL input field
  - "Install" button
  - Optional advanced: integrity hash field (auto-extracted from URL fragment if present)
- During install: progress indicator (spinner). On error: inline error message. On success: modal closes, new plugin appears in the list.
- "Uninstall" affordance on each installed plugin (button reveals on hover).

`src/data.js`: drop `PLUGINS`. The runtime list comes from the coordinator's `installedPlugins`.

`PLUGIN_CATALOG` in App.jsx is built from the coordinator's `installedPlugins` + the engine's loaded manifests at boot, replacing today's static map.

---

## 11. Testing

### 11.1 Vitest (Node)

- `PluginInstaller.test.ts` — Build a small `.noaplugin` ZIP in-test via fflate, stub fetch + OPFS, exercise installFromUrl. Verify manifest validation, SHA-256 hashing, size/path safety rejection.
- `InstalledPluginsStore`-shape reducer tests for the new actions.
- `plugin-cache.sw.ts` core logic (path routing, OPFS lookup) — factor into a `SwCore` class like we did with `PluginWorkerCore`, test with a fake OPFS.

### 11.2 Playwright browser smoke

- Boot the app. Verify `/_noa/plugin-ui/...` is served by the SW (response source = ServiceWorker per `e.source` if observable; otherwise just `200`).
- Install a known `.noaplugin` from a fixture URL.
- Disable network → reload → installed plugin still loads.

### 11.3 What we deliberately don't test

- Cross-origin URL installs (CORS) — out of scope; SRI verification is what we trust.
- Multi-version concurrent loads — single-version per id in v1.

---

## 12. Risks and open questions

- **SW registration in dev.** localhost is treated as secure context, so the SW registers. In production behind HTTPS this works too. Self-hosted HTTP deployments don't work; that's a known limitation.
- **OPFS race conditions on install.** The staging directory + atomic move handles partial installs but two concurrent installs of the same plugin could race. v1 serializes installs via a single in-flight Promise on the installer.
- **SW lifecycle vs. iframe load.** If the iframe is created before the SW activates, requests miss the cache. We `await navigator.serviceWorker.ready` before any plugin UI opens.
- **fflate bundle size.** ~25 KB minified, adds ~8 KB gzip to the main bundle. Acceptable.
- **Built-in plugin seeding.** First app boot needs to copy the built-ins from the Vite bundle into OPFS. Subsequent boots skip if `/plugins/com.noa.sine/1.0.0/` already exists.

---

## 13. Decisions explicitly rejected

- **Cache API instead of OPFS.** Cache API works for the SW intercept path, but OPFS is what the coordinator already uses for project persistence and lets us reuse one storage layer. Single source of truth.
- **Pre-compiled SW with `BroadcastChannel` for messaging.** `MessagePort` via `ServiceWorkerContainer.controller.postMessage` is simpler for this v1.
- **Per-version directories with hash subpaths** (e.g., `<id>/<sha256>/`). v1 uses semver `<version>` since we only support one version per id; content-addressing arrives when we add updates.
- **Service Worker app-shell caching.** Out of scope; only `/_noa/*` URLs are SW-served.
- **`AbortSignal` plumbing through install.** v1 install is non-cancellable; user UX has a spinner and waits.
