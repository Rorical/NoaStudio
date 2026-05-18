# Phase 4: Plugin Host Workers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-instance JS `Worker` that runs slow non-RT work (preset compilation, future analysis), with an ABI v1.1 prepare/serialize/free split so the worklet only ever applies state via a fast memcpy.

**Design reference:** `docs/superpowers/specs/2026-05-18-phase-4-plugin-workers-design.md`.

**Tech stack additions:** None — uses standard `Worker`, `MessageChannel`, existing `SharedArrayBuffer` rings, existing AssemblyScript toolchain.

**Phase 3 invariants kept:**
- The worklet stays the single audio render surface.
- Per-instance event/notify rings still carry UI ↔ engine traffic.
- The Phase 3 demo (audio plays through sine → gain) keeps working at every commit.

**Out of scope (deferred to Phase 4b / 5+):**
- Audio scope SAB ring (Phase 4b).
- OffscreenCanvas in iframes (Phase 5+).
- Worker pool (Phase 5+).
- Shared linear memory between RT and non-RT (Phase 5+).

---

## File structure

**Create:**
- `src/engine/PluginWorker.ts` — main-thread façade over the worker port.
- `src/engine/plugin-host.worker.ts` — worker entry; instantiates a second WASM and serves PREPARE_PRESET.
- `src/engine/__tests__/PluginWorker.test.ts`
- `src/engine/__tests__/fixtures/preset-test/` — fixture plugin with v1.1 exports.

**Modify:**
- `src/engine/PluginAbi.ts` — add preset_* export name constants.
- `src/engine/PluginInstance.ts` — expose `preparePreset` / `serializePreset` / `freePreset` helpers backed by the new exports.
- `src/engine/audio-worklet.ts` — handle `APPLY_PRESET_STATE`.
- `src/engine/WorkletProtocol.ts` — add `applyPresetState(slot, bytes)`.
- `src/engine/EngineClient.ts` — orchestrate per-instance workers; expose `preparePreset` / `activatePreset`.
- `src/engine/PluginUIProtocol.ts` — add `PRESET_REQUEST` envelope.
- `src/engine/PluginUIHost.ts` — bootstrap exposes `window.__noa.applyPreset(bytes)` + relays.
- `src/components/PluginWindow.jsx` — forwards `PRESET_REQUEST` to App.
- `src/App.jsx` — wires the iframe `PRESET_REQUEST` → `EngineClient.preparePreset` + `activatePreset`.
- `src/builtin-plugins/sine/src/index.ts` — v1.1 exports + synthetic 30ms delay in `noa_preset_prepare`.
- `src/builtin-plugins/sine/ui/index.html` — preset buttons row.
- `scripts/build-plugins.sh` — add the new fixture folder.
- `docs/plugin-abi-v1.md` — append v1.1 section.
- `CLAUDE.md` — note the new module + ABI.
- `docs/superpowers/plans/2026-05-17-noa-daw-roadmap.md` — mark Phase 4 shipped.

---

### Task 1: ABI v1.1 export name constants

**Files:** `src/engine/PluginAbi.ts`, `docs/plugin-abi-v1.md`.

- [ ] **Step 1: Extend `EXPORTS` in `PluginAbi.ts`** with `preset_prepare`, `preset_get_state_size`, `preset_serialize`, `preset_free`. Add a small `PRESET_EXPORTS` array (the four names) for easy "are all four present?" checks.

- [ ] **Step 2: Append a v1.1 section** to `docs/plugin-abi-v1.md` mirroring the design spec's Section 4. Author-facing.

- [ ] **Step 3: Commit.** `feat(engine): plugin ABI v1.1 preset prepare/activate symbol constants`

---

### Task 2: `preset-test` fixture plugin

**Files:** `src/engine/__tests__/fixtures/preset-test/` (new), `scripts/build-plugins.sh`.

A tiny AS plugin used to drive PluginInstance and PluginWorker unit tests. Manifest:

```json
{
  "id": "com.noa.preset-test",
  "name": "Preset Test",
  "version": "0.0.1",
  "abi_version": 1,
  "kind": "fx",
  "params": [
    { "name": "A", "min": 0, "max": 1, "default": 0 },
    { "name": "B", "min": 0, "max": 1, "default": 0 }
  ]
}
```

AS source (sketch):
- Standard ABI v1 exports (passthrough audio, scaled by `A`).
- `noa_preset_prepare(in_ptr, in_len) -> handle`: validates a 12-byte payload (`'NTP1'` magic + two `f32`), stores in a 4-slot fixed array.
- `noa_preset_get_state_size(handle)` → `8`.
- `noa_preset_serialize(handle, out_ptr)` writes the two `f32`s.
- `noa_preset_free(handle)` clears the slot.

- [ ] **Step 1**: AS source + manifest + asconfig + package.json + README.
- [ ] **Step 2**: Add to `scripts/build-plugins.sh` (test-fixture path → outputs `plugin.wasm`).
- [ ] **Step 3**: Build, verify the artefact loads via Node's `WebAssembly.instantiate`.
- [ ] **Step 4**: Commit. `build(plugins): preset-test fixture (ABI v1.1 exports)`

---

### Task 3: `PluginInstance` v1.1 helpers (TDD)

**Files:** `src/engine/PluginInstance.ts`, `src/engine/__tests__/PluginInstance.test.ts`.

Add to PluginInstance:

```ts
hasPresetSupport(): boolean
preparePreset(bytes: Uint8Array): number            // returns handle, throws on failure
serializePreset(handle: number): Uint8Array
freePreset(handle: number): void
```

`hasPresetSupport()` returns true iff the WASM exports all four v1.1 symbols.

`preparePreset` writes `bytes` into the plugin's event-buffer scratch region (reusing it; OK between blocks) and calls `noa_preset_prepare`. Throws if the handle is 0.

- [ ] **Step 1**: Write failing tests against the `preset-test` fixture: `hasPresetSupport` true; round-trip `preparePreset` → `serializePreset` → `setState` on a fresh instance leaves params matching the prepared values; `freePreset` is a no-op smoke.
- [ ] **Step 2**: Implement helpers.
- [ ] **Step 3**: Run tests + typecheck.
- [ ] **Step 4**: Commit. `feat(engine): PluginInstance preset_prepare / serialize / free helpers`

---

### Task 4: `PluginWorker` (main-thread façade)

**Files:** `src/engine/PluginWorker.ts`, `src/engine/__tests__/PluginWorker.test.ts`.

Surface:

```ts
class PluginWorker {
  constructor(port: MessagePortLike);
  spawn(args: { instanceId, module, manifest, sampleRate, maxBlockSize }): Promise<void>;
  preparePreset(bytes: Uint8Array): Promise<PreparedPreset>;
  freePreset(handle: number): void;
  dispose(): void;
}
```

The class is constructed with any `MessagePortLike` — exactly like `WorkletProtocol` — so tests use a fake port. Real callers pass `worker.port` (since `Worker.postMessage` is on the worker object, not a port; we wrap it in an adapter or use a `MessageChannel`).

Implementation note: for the real worker, the cleanest path is to construct a `MessageChannel`, give one port to the worker via the constructor's `transfer` arg, and use the other on the main thread. That lets us pass the same port shape to `PluginWorker`.

- [ ] **Step 1**: Write failing tests (fake port): HELLO send, READY → spawn resolves, PREPARE_PRESET → PRESET_PREPARED resolves with `{handle, stateBytes}`, PRESET_PREPARE_FAILED rejects, dispose rejects pending and is idempotent.
- [ ] **Step 2**: Implement.
- [ ] **Step 3**: Run tests + typecheck.
- [ ] **Step 4**: Commit. `feat(engine): PluginWorker — main-thread side of the worker protocol`

---

### Task 5: `plugin-host.worker.ts` — worker entry

**Files:** `src/engine/plugin-host.worker.ts`, manual smoke test.

Vitest can't run audio worklets but it *can* spawn `Worker`s in Node 22+. We'll add a small integration test that:

1. Spawns the worker via `new Worker(new URL('../plugin-host.worker.ts', import.meta.url))`.
2. Sends HELLO with the fixture module + manifest.
3. Awaits READY.
4. Sends PREPARE_PRESET with a valid preset payload.
5. Awaits PRESET_PREPARED; verifies the `stateBytes` round-trip.

Worker module structure:
- `self.onmessage` handles HELLO, PREPARE_PRESET, FREE_PRESET.
- On HELLO: `PluginInstance.fromModule(module, manifest, opts)` (no rings); store globally.
- On PREPARE_PRESET: call `instance.preparePreset(bytes)`; serialize; reply.

- [ ] **Step 1**: Worker source.
- [ ] **Step 2**: Integration test that spawns the real worker.
- [ ] **Step 3**: Run tests + typecheck.
- [ ] **Step 4**: Commit. `feat(engine): plugin-host.worker — instantiates a second WASM per plugin`

---

### Task 6: Worklet — `APPLY_PRESET_STATE` handler

**Files:** `src/engine/audio-worklet.ts`, `src/engine/WorkletProtocol.ts`.

New inbound message (handled in `port.onmessage`, not queued):

```
APPLY_PRESET_STATE { slot, stateBytes }
```

The worklet looks up the chain slot, calls `instance.setState(stateBytes)`, and (optionally) posts an ack.

`WorkletProtocol.applyPresetState(slot, bytes)` posts the message.

- [ ] **Step 1**: Extend `WorkletInbound` union + handler in `audio-worklet.ts`.
- [ ] **Step 2**: Add `WorkletProtocol.applyPresetState`.
- [ ] **Step 3**: Extend `WorkletProtocol.test.ts` with the new message.
- [ ] **Step 4**: Run tests + typecheck + commit. `feat(engine): worklet APPLY_PRESET_STATE — fast in-block setState`

---

### Task 7: `EngineClient` orchestration

**Files:** `src/engine/EngineClient.ts`.

`loadPlugin` continues to spawn the worklet instance, then **also**:

1. Constructs a `MessageChannel`.
2. Spawns the worker (`new Worker(workerUrl, { type: 'module' })`).
3. Sends a `connect-port` message that transfers one channel port to the worker.
4. Wraps the other port in a `PluginWorker`.
5. Calls `PluginWorker.spawn({module, manifest, sampleRate, maxBlockSize})`.
6. Stores `{ slot, worker }` keyed by `instanceId`.

New methods:

```ts
preparePreset(args: { instanceId, bytes }): Promise<PreparedPreset>;
activatePreset(args: { instanceId, preparedStateBytes }): Promise<void>;
freePreset(args: { instanceId, handle }): void;
```

`unloadInstance` adds `worker.dispose()` and `worker.terminate()` calls.

- [ ] **Step 1**: Add the orchestration + new methods + unit-level smoke (mock the port).
- [ ] **Step 2**: Run tests + typecheck.
- [ ] **Step 3**: Commit. `feat(engine): EngineClient spawns + drives a per-instance worker`

---

### Task 8: Sine plugin gets v1.1 + preset bank

**Files:** `src/builtin-plugins/sine/src/index.ts`, `src/builtin-plugins/sine/README.md`, plugin.wasm rebuild.

AS additions:
- 4 static `PresetSlot` records.
- `noa_preset_prepare`: validates `'NSP1'` magic + 8 bytes payload + busy-loops for 30 ms (configurable constant `PRESET_DELAY_MS`).
- Other three exports as per spec.
- Preset payload: 12 bytes (`'NSP1'` 4B + Volume `f32` + Octave `f32`).

- [ ] **Step 1**: Update AS source.
- [ ] **Step 2**: Rebuild via `./scripts/build-plugins.sh`.
- [ ] **Step 3**: Add a Node-side test (`src/engine/__tests__/builtin-sine.test.ts`) that exercises preparePreset.
- [ ] **Step 4**: Commit. `feat(plugins): sine plugin v1.1 — preset_prepare with 30ms synthetic delay`

---

### Task 9: Plugin UI — preset request envelope + bootstrap helper

**Files:** `src/engine/PluginUIProtocol.ts`, `src/engine/PluginUIHost.ts`, `src/builtin-plugins/sine/ui/index.html`.

Protocol additions:
```ts
interface PresetRequestMessage {
  type: 'PRESET_REQUEST';
  bytes: Uint8Array;
}
```

Bootstrap script gains `window.__noa.applyPreset(bytes)` which posts `PRESET_REQUEST` to the parent.

The host's iframe `message` handler routes `PRESET_REQUEST` to a new prop callback `onPresetRequest(bytes)` on `PluginUIHost.openWindow`.

Sine UI: three buttons (`Bright`, `Mellow`, `Default`). Each builds the 12-byte preset payload and calls `window.__noa.applyPreset(payload)`.

- [ ] **Step 1**: Extend protocol + tests.
- [ ] **Step 2**: Extend `PluginUIHost.openWindow` + bootstrap.
- [ ] **Step 3**: Update sine UI.
- [ ] **Step 4**: Run tests + typecheck + commit. `feat(plugins): PRESET_REQUEST plumbing + sine preset buttons`

---

### Task 10: App.jsx wires the preset flow end-to-end

**Files:** `src/App.jsx`, `src/components/PluginWindow.jsx`.

`PluginWindow` accepts an `onPresetRequest(instanceId, bytes)` prop; passes it down to `PluginUIHost.openWindow`.

App.jsx defines:

```js
const handlePresetRequest = useCallback(async (instanceId, bytes) => {
  const engine = engineRef.current;
  if (!engine) return;
  const prepared = await engine.preparePreset({ instanceId, bytes });
  await engine.activatePreset({ instanceId, preparedStateBytes: prepared.stateBytes });
  engine.freePreset({ instanceId, handle: prepared.handle });
}, []);
```

Passed to each `<PluginWindow>` instance in the open-windows map.

- [ ] **Step 1**: Plumbing.
- [ ] **Step 2**: Manual smoke — open sine window, click each preset, audio adjusts without glitch.
- [ ] **Step 3**: Commit. `feat(app): wire preset flow — UI → worker → worklet`

---

### Task 11: Docs + final verification

**Files:** `CLAUDE.md`, `docs/superpowers/plans/2026-05-17-noa-daw-roadmap.md`.

- [ ] Update CLAUDE.md (new module section).
- [ ] Mark Phase 4 ✓ shipped in the roadmap.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`.
- [ ] Commit.

---

## Self-review checklist

**Spec coverage:**
- ABI v1.1 preset exports → Task 1, 2, 3, 8.
- Per-instance worker → Tasks 4, 5, 7.
- Worklet APPLY_PRESET_STATE → Task 6.
- UI plumbing → Tasks 9, 10.
- Preset bank demo → Tasks 8, 9, 10.

**Test coverage:**
- `PluginAbi` constants → smoke (no test needed).
- `PluginInstance` v1.1 helpers → Task 3 tests.
- `PluginWorker` (fake port) → Task 4 tests.
- `plugin-host.worker.ts` (real worker) → Task 5 integration test.
- `WorkletProtocol.applyPresetState` → Task 6.
- Sine v1.1 end-to-end → Task 8 Node test + Task 10 manual smoke.

**Risks acknowledged:**
- `noa_set_state` cost — documented in ABI docs.
- Worker startup latency — accepted for v1.
- Module structured-clone cost — verified by manual smoke in Task 10.
