# Phase 5: Service Worker Delivery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship a Service Worker at `/_noa/*` that serves plugin assets from OPFS, a `.noaplugin` ZIP install flow, and a coordinator-owned `installedPlugins` list. Phase 4 demo keeps working; new offline-reload demo lights up.

**Design reference:** `docs/superpowers/specs/2026-05-18-phase-5-service-worker-delivery-design.md`.

**Tech stack additions:**
- `fflate` (npm dep, ~25 KB minified) for ZIP unpacking.

**Phase 4 invariants kept:**
- The audio worklet + per-instance worker continue to work unchanged. Plugins ship as wasm bytes; nothing about the runtime path changes.
- Existing 182 unit tests keep passing at every commit.

**Out of scope (deferred):**
- Project-asset URL space.
- App-shell offline caching.
- Multi-version per plugin id.
- Permissions / sandboxed install.

---

## File structure

**Create:**
- `src/sw/plugin-cache.sw.ts` — Service Worker entry. Thin shell wiring `self.onmessage` and `self.addEventListener('fetch', ...)` to a `SwCore` class.
- `src/sw/SwCore.ts` — Platform-agnostic message + fetch router (testable in Node).
- `src/sw/OpfsPluginStore.ts` — Read/write helpers on top of OPFS at `/plugins/<id>/<version>/`.
- `src/sw/registerSW.js` — Main-thread registration helper, fall-back path, `await navigator.serviceWorker.ready`.
- `src/engine/PluginInstaller.ts` — `.noaplugin` URL → OPFS install + coordinator INSTALL_PLUGIN dispatch.
- `src/engine/__tests__/PluginInstaller.test.ts`
- `src/sw/__tests__/SwCore.test.ts`
- `src/sw/__tests__/OpfsPluginStore.test.ts`

**Modify:**
- `package.json` — `fflate` dep; build:plugins script unchanged.
- `vite.config.js` — add `plugin-cache-sw` as a build input, emit at `/plugin-cache-sw.js`.
- `src/main.jsx` — call `registerSW()` on startup.
- `src/coordinator/projectModel.ts` — add `InstalledPlugin` + `Project.installedPlugins`.
- `src/coordinator/actions.ts` — `INSTALL_PLUGIN`, `UNINSTALL_PLUGIN`.
- `src/coordinator/reducer.ts` — handlers.
- `src/coordinator/__tests__/reducer.test.ts` — new cases.
- `src/engine/PluginUIHost.ts` — switch primary path to `/_noa/plugin-ui/<instanceId>/...`; keep Blob fallback.
- `src/engine/bootBuiltins.js` — seeds OPFS from the bundled built-ins if absent.
- `src/engine/PluginRegistry.ts` — `loadInstalled(store)` static helper that lists from the coordinator + reads bytes from OPFS.
- `src/App.jsx` — populate `pluginCatalog` from `installedPlugins`; thread the installer into the Browser.
- `src/components/Browser.jsx` — "Install from URL" modal + uninstall affordance.
- `src/data.js` — drop the static `PLUGINS` constant; coordinator seed now drives the Browser list.
- `CLAUDE.md` — new module section + commands.
- `docs/superpowers/plans/2026-05-17-noa-daw-roadmap.md` — mark Phase 5 shipped.

---

### Task 1: fflate dep + Vite SW input

**Files:** `package.json`, `vite.config.js`.

- [ ] **Step 1:** `npm install --save fflate@^0.8`.
- [ ] **Step 2:** Extend `vite.config.js` `rollupOptions.input` with `'plugin-cache-sw': resolve(import.meta.dirname, 'src/sw/plugin-cache.sw.ts')`. Add to `entryFileNames`: emit at the build root as `plugin-cache-sw.js` so the SW URL is stable across builds.
- [ ] **Step 3:** Add `dist/plugin-cache-sw.js` placeholder check to the typecheck script.
- [ ] **Step 4:** Commit. `build: fflate dep + Vite SW build input`

---

### Task 2: OpfsPluginStore — pure OPFS read/write

**Files:** `src/sw/OpfsPluginStore.ts`, `src/sw/__tests__/OpfsPluginStore.test.ts`.

API:

```ts
class OpfsPluginStore {
  constructor(root: FileSystemDirectoryHandle); // /plugins/ subroot

  async write(pluginId: string, version: string, files: Map<string, Uint8Array>): Promise<void>;
  async readFile(pluginId: string, version: string, path: string): Promise<Uint8Array | null>;
  async list(): Promise<Array<{ pluginId: string; version: string }>>;
  async remove(pluginId: string, version: string): Promise<void>;
  /** Atomic install: stage to a temp dir, then rename. */
  async stageAndInstall(args: { pluginId: string; version: string; files: Map<string, Uint8Array> }): Promise<void>;
}
```

- [ ] **Step 1:** TDD with an in-memory `FakeOpfsHandle` (Map-backed) — Node has no OPFS so we hand-roll a stub matching the FS Access API enough to drive the unit tests.
- [ ] **Step 2:** Implement. Path safety check: reject any `path` containing `..` or starting with `/`.
- [ ] **Step 3:** Commit. `feat(sw): OpfsPluginStore — OPFS read/write helpers for plugins`

---

### Task 3: SwCore — fetch + message routing

**Files:** `src/sw/SwCore.ts`, `src/sw/__tests__/SwCore.test.ts`.

The Service Worker file itself wires `self.onmessage`/`self.addEventListener('fetch', ...)` to a `SwCore` instance. All routing logic lives in `SwCore` so it's testable.

```ts
class SwCore {
  constructor(store: OpfsPluginStore);

  handleMessage(data: unknown): void; // BIND_INSTANCE | UNBIND_INSTANCE | INVALIDATE_PLUGIN | PING (replies via the postMessage source)

  async handleFetch(url: URL): Promise<Response | null>; // returns null if URL is not in the /_noa/* namespace
}
```

URL routing:
- `/_noa/plugins/<pluginId>/<version>/wasm` → `store.readFile(pluginId, version, 'plugin.wasm')`, `Content-Type: application/wasm`
- `/_noa/plugins/<pluginId>/<version>/manifest` → `store.readFile(pluginId, version, 'plugin.json')`, `application/json`, `Cache-Control: no-store`
- `/_noa/plugin-ui/<instanceId>/<path>` → look up binding, `store.readFile(pluginId, version, 'ui/' + path)`, guess content-type from extension

All responses set `Cross-Origin-Resource-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.

- [ ] **Step 1:** Write failing tests against the fake OPFS store.
- [ ] **Step 2:** Implement SwCore.
- [ ] **Step 3:** Commit. `feat(sw): SwCore — URL routing for /_noa/* + message handling`

---

### Task 4: plugin-cache.sw.ts wire-up

**Files:** `src/sw/plugin-cache.sw.ts`.

```ts
/// <reference lib="webworker" />
import { OpfsPluginStore } from './OpfsPluginStore';
import { SwCore } from './SwCore';

const root = await navigator.storage.getDirectory();
const pluginsRoot = await root.getDirectoryHandle('plugins', { create: true });
const store = new OpfsPluginStore(pluginsRoot);
const core = new SwCore(store);

self.addEventListener('install', (e) => { (self as ServiceWorkerGlobalScope).skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil((self as ServiceWorkerGlobalScope).clients.claim()); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (!url.pathname.startsWith('/_noa/')) return;
  e.respondWith(core.handleFetch(url).then((r) => r ?? new Response(null, { status: 404 })));
});
self.addEventListener('message', (e) => core.handleMessage(e.data));
```

- [ ] **Step 1:** Author the file.
- [ ] **Step 2:** Manual smoke — `npm run build`, inspect `dist/plugin-cache-sw.js` exists.
- [ ] **Step 3:** Commit. `feat(sw): plugin-cache.sw.ts wire-up`

---

### Task 5: registerSW + main.jsx integration

**Files:** `src/sw/registerSW.js`, `src/main.jsx`.

```js
export async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/plugin-cache-sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    return reg;
  } catch (err) {
    console.warn('[noa] SW registration failed; falling back to Blob URLs:', err);
    return null;
  }
}
```

`main.jsx` calls it before rendering — the registration is non-blocking but we capture the result on `window.__noa.swReady` (a Promise) for the UI host to await.

- [ ] **Step 1:** Author + wire up.
- [ ] **Step 2:** Smoke in Playwright: `navigator.serviceWorker.controller` is non-null after reload.
- [ ] **Step 3:** Commit. `feat(sw): main-thread registerSW helper`

---

### Task 6: Built-in plugin seeding on first boot

**Files:** `src/engine/bootBuiltins.js`, `src/sw/seedBuiltins.js` (new).

On first boot (`store.list()` returns empty), copy the bundled built-in plugin assets into OPFS:

```js
async function seedBuiltins(store) {
  if ((await store.list()).length > 0) return;
  for (const [id, version, files] of BUILTIN_BUNDLES) {
    await store.stageAndInstall({ pluginId: id, version, files });
  }
}
```

`BUILTIN_BUNDLES` is constructed from the existing Vite imports (`?url` + `?raw`) — fetch the wasm bytes + the UI HTML, package as a Map.

- [ ] **Step 1:** Implement `seedBuiltins`.
- [ ] **Step 2:** Call from main thread after SW ready.
- [ ] **Step 3:** Commit. `feat(sw): seed built-ins into OPFS on first boot`

---

### Task 7: Coordinator InstalledPlugin model + actions

**Files:** `src/coordinator/projectModel.ts`, `actions.ts`, `reducer.ts`, `reducer.test.ts`, `data.js` seed.

Add `InstalledPlugin` to project model. Seed has the two built-ins.

New actions: `INSTALL_PLUGIN { entry }`, `UNINSTALL_PLUGIN { pluginId }`. Reducer cases handle add/remove, dedupe by pluginId.

- [ ] **Step 1:** TDD reducer cases.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Commit. `feat(coordinator): installedPlugins model + INSTALL/UNINSTALL actions`

---

### Task 8: PluginInstaller

**Files:** `src/engine/PluginInstaller.ts`, `src/engine/__tests__/PluginInstaller.test.ts`.

Implements the install flow per design Section 8. TDD against an in-memory OPFS stub and a stubbed `fetch`.

- [ ] **Step 1:** Write tests: happy path, SRI mismatch, oversized ZIP, path-traversal entry, bad manifest, bad wasm.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Commit. `feat(engine): PluginInstaller — .noaplugin install from URL`

---

### Task 9: PluginUIHost switch to SW URLs

**Files:** `src/engine/PluginUIHost.ts`.

- [ ] **Step 1:** Add a `useServiceWorker: boolean` opt-in (passed via constructor). When true, `openWindow` posts `BIND_INSTANCE` to the SW and creates `<iframe src="/_noa/plugin-ui/<instanceId>/<entry>">`; on close, posts `UNBIND_INSTANCE`.
- [ ] **Step 2:** When false (or SW absent), fall back to the existing Blob URL path.
- [ ] **Step 3:** Update App.jsx to set `useServiceWorker: !!await window.__noa.swReady`.
- [ ] **Step 4:** Commit. `feat(engine): PluginUIHost serves UIs via Service Worker when available`

---

### Task 10: Browser "Install from URL" modal

**Files:** `src/components/Browser.jsx`, `src/App.jsx`.

- [ ] **Step 1:** Modal markup + state (URL input, spinner, error).
- [ ] **Step 2:** Submit handler: `engine.installer.installFromUrl(url)`. On success, dispatch `INSTALL_PLUGIN`. On error: inline message.
- [ ] **Step 3:** Uninstall affordance on each installed plugin.
- [ ] **Step 4:** Commit. `feat(app): Install plugin from URL UI`

---

### Task 11: Offline reload demo + docs

**Files:** `CLAUDE.md`, roadmap.

- [ ] **Step 1:** Manual smoke: install a small `.noaplugin` (we can host one as a test asset under `public/test-plugin.noaplugin`). Reload with network disabled. Plugin still loads.
- [ ] **Step 2:** CLAUDE.md update.
- [ ] **Step 3:** Mark Phase 5 shipped in roadmap.
- [ ] **Step 4:** Run full verification (tests + typecheck + build).
- [ ] **Step 5:** Commit. `docs: Phase 5 shipped — SW delivery + installable plugins`

---

## Self-review checklist

**Spec coverage:**
- SW registration → Task 5
- OPFS plugin store → Tasks 2, 6
- URL routing → Task 3
- `.noaplugin` install → Task 8
- UI host SW switch → Task 9
- Coordinator persistence → Task 7
- Browser UI → Task 10
- Offline demo → Task 11

**Test coverage:**
- OpfsPluginStore — Task 2 (fake OPFS).
- SwCore — Task 3 (fake OPFS).
- PluginInstaller — Task 8 (fake OPFS + fetch).
- Reducer for new actions — Task 7.
- SW behaviour end-to-end — Task 11 manual smoke (no Vitest can spin up a real SW).

**Risks acknowledged:** SW lifecycle gotchas (await `serviceWorker.ready` everywhere a SW URL is fetched); OPFS quota limits (50 MB cap per install enforced upstream); built-in seeding (idempotent — checks for existence first).
