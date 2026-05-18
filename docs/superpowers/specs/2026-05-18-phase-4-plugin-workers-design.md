# Phase 4: Plugin Host Workers — Design Spec

**Status:** Design locked. Plan: `docs/superpowers/plans/2026-05-18-phase-4-plugin-workers.md`.

**Predecessors:** Phase 3 (WASM Plugin ABI v1) shipped. Plugins run in the audio worklet via `PluginChain`; per-instance event/notify rings carry UI ↔ engine traffic; floating HTML UIs are wired up.

**This phase adds a dedicated `Worker` per plugin instance for off-RT work — preset compilation, offline rendering, heavy analysis — without glitching audio.**

---

## 1. Goal

End-to-end demo at the end of Phase 4:

1. Open Noa. The sine plugin loads as in Phase 3.
2. Open its plugin window — there's a row of preset buttons (`Bright`, `Mellow`, `Default`).
3. Hit Play; hold a note.
4. Click a preset button. Audio continues uninterrupted, the knobs animate to their new positions, and the new sound takes effect within ~1 audio block.
5. The preset payload includes a synthetic 30 ms `await` in the worker's parse path. The audio doesn't notice — the worker bears the cost; the worklet only sees a fast, prepared "hot" state.

The architecture lets plugin authors put arbitrarily slow work behind preset switches: wavetable decoding, FFT IR loading, network preset library fetches, etc. The worklet only ever sees memcpy-cost activations.

---

## 2. Out of scope (deferred)

- **Oscilloscope / per-instance audio scope ring** — Phase 4b. The roadmap calls this out as a worked example; we ship the worker infrastructure first, the scope example second.
- **OffscreenCanvas transfer from iframe to worker** — Phase 5+. Plugins that want heavy visualization currently render on main thread.
- **Worker pool / shared worker** — Phase 5+. One worker per plugin instance.
- **Shared linear memory between RT and non-RT WASM** — out of scope. Each side instantiates its own instance from the same `WebAssembly.Module`.
- **`.noaplugin` ZIP delivery** — Phase 5 still.

---

## 3. Architecture

```
Main thread                       Worker (per instance)            Worklet
───────────                       ──────────────────────           ───────
EngineClient                                                       PluginChain
  loadPlugin                                                         install slot
  preparePreset(bytes) ────postMessage────▶  WASM instance #2
                                              noa_preset_prepare
                                              (bytes) -> handle
                              ◀──postMessage── { ok, handle }
  activatePreset(handle) ──────postMessage to worklet port──▶  WASM instance #1
                                                                noa_preset_activate(handle)
                                                                  fast swap (memcpy)
                              ◀──INSTANCE_PRESET_ACTIVATED──── (optional ack)
```

Key points:

- **One `Worker` per `PluginInstance`.** Cheap on modern Chromium (kilobytes of state, no shared scheduling pressure).
- **Two `WebAssembly.Instance`s per plugin** — one in the worker, one in the worklet. They share the same compiled `WebAssembly.Module` (transferred by structured clone), but each has its own linear memory.
- **The worker is the "slow path."** It calls `noa_preset_prepare` (which may take 30+ ms) and stores the result inside its WASM instance, indexed by a handle.
- **Synchronizing prepared state to the worklet:** the worker calls `noa_get_state()` on its instance and ships the resulting bytes to the worklet, where the worklet calls `noa_set_state` between blocks. This relies on `noa_set_state` being O(memcpy) — see ABI v1.1.
- **Communication:** the main thread is the relay. Worker ↔ Main is `Worker.postMessage`. Main ↔ Worklet is the existing `AudioWorkletNode.port`. There's no direct Worker ↔ Worklet channel in Phase 4 — adding a `MessageChannel` port transfer is a Phase 5 optimization once the relay overhead becomes measurable.

---

## 4. ABI v1.1 additions

ABI version stays at **1** — these are additive, optional, and the host fall-back applies when a plugin doesn't export them.

### 4.1 New exports

| Symbol | Signature | Required | Purpose |
| --- | --- | --- | --- |
| `noa_preset_prepare` | `(in_ptr: u32, in_len: u32) -> u32` | no | Parse compressed preset bytes (from `in_ptr` in the plugin's linear memory) into a "hot" form. Returns a non-zero handle on success, `0` on failure. May take arbitrarily long — runs on the worker thread. |
| `noa_preset_get_state_size` | `(handle: u32) -> u32` | no | Number of bytes a prepared preset would occupy in the standard `noa_get_state` format. |
| `noa_preset_serialize` | `(handle: u32, out_ptr: u32) -> u32` | no | Write the prepared preset's bytes to `out_ptr` in the format `noa_set_state` accepts. Returns bytes written. Host calls this on the **worker** instance to ship state to the **worklet** instance. |
| `noa_preset_free` | `(handle: u32) -> void` | no | Release the prepared preset. Worker calls this when the host signals it can drop the handle. |

The worklet keeps using the existing `noa_set_state(in_ptr, n_bytes)` to apply prepared state. The ABI v1.1 contract is: **`noa_set_state` must be O(memcpy + atomic indices).** Plugins that put parsing or table-rebuilding logic in `noa_set_state` will still cause glitches.

### 4.2 Backward compatibility

A plugin that doesn't export `noa_preset_prepare` is loaded as in Phase 3. The host's `preparePreset` call rejects with a `not-supported` error. UIs can hide preset buttons accordingly.

A plugin that exports only some of the four new symbols is rejected at registry-install time (a partial set is malformed).

### 4.3 Worker-side error handling

If `noa_preset_prepare` returns `0`, the worker posts `PRESET_PREPARE_FAILED { reason }` back to main thread. The reason string is constructed from the optional `host.log` calls the plugin made before failing.

---

## 5. Worker model

### 5.1 Lifecycle

- One JS `Worker` per `PluginInstance`, created **after** the worklet's `INSTANCE_READY` fires.
- The worker is initialized with: the compiled `WebAssembly.Module`, the manifest, and the same `sampleRate` + `maxBlockSize` used by the worklet's instance.
- The worker instantiates the module via `new WebAssembly.Instance(module, ...)` synchronously inside its global scope. Same import object (`host.log`, `host.random`, `host.get_tempo`) but `host_get_tempo` returns a snapshot, not a live value — the worker isn't synced to the audio clock.
- The worker calls `noa_init(sampleRate, maxBlockSize)` once. Its instance has its own linear memory; the host's `noa_get_*_ptr` exports are cached.
- The worker stays alive for the lifetime of the plugin instance. It's terminated on `engine.unloadInstance`.

### 5.2 Worker responsibilities (Phase 4 scope)

- Receive `PREPARE_PRESET { bytes }` requests.
- Write `bytes` into the plugin's input event-buffer slot (reusing it as preset scratch).
- Call `noa_preset_prepare(scratch_ptr, bytes_len)` — slow.
- On success, call `noa_preset_get_state_size(handle)` and `noa_preset_serialize(handle, out_ptr)`.
- Post `PRESET_PREPARED { handle, stateBytes }` back to main thread.

### 5.3 Worker responsibilities (Phase 4b)

- Receive audio sample ring SAB; tap output samples; compute downsampled waveform; post to main thread.

These do not exist in Phase 4 v1.

---

## 6. Host-side protocol

### 6.1 Main thread API (new on `EngineClient`)

```typescript
class EngineClient {
  // ...existing
  preparePreset(args: {
    instanceId: string;
    bytes: Uint8Array;
  }): Promise<PreparedPreset>;

  activatePreset(args: {
    instanceId: string;
    preparedStateBytes: Uint8Array;
  }): Promise<void>;
}

interface PreparedPreset {
  instanceId: string;
  /** Worker-side handle; the host calls EngineClient.freePreset(handle) when done. */
  handle: number;
  /** Hot state bytes ready for noa_set_state on the worklet's instance. */
  stateBytes: Uint8Array;
}
```

### 6.2 Worker control protocol

Main thread → worker:
```
HELLO          { module, manifest, sampleRate, maxBlockSize }
PREPARE_PRESET { requestId, bytes }
FREE_PRESET    { handle }
```

Worker → main thread:
```
READY                  {}
PRESET_PREPARED        { requestId, handle, stateBytes }
PRESET_PREPARE_FAILED  { requestId, error }
```

### 6.3 Worklet additions

A single new inbound message:

```
APPLY_PRESET_STATE { instanceId, stateBytes }
```

The worklet calls `instance.setState(stateBytes)` — same code path as the existing test fixture's `setState` method, but invoked between blocks via `port.onmessage`.

No reply needed; `noa_set_state` returning 0 (failure) is logged via `host.log` but the host's promise resolves either way.

### 6.4 PluginWorker (main-thread façade)

```typescript
class PluginWorker {
  static spawn(args: {
    instanceId: string;
    module: WebAssembly.Module;
    manifest: PluginManifest;
    sampleRate: number;
    maxBlockSize: number;
  }): Promise<PluginWorker>;

  preparePreset(bytes: Uint8Array): Promise<PreparedPreset>;
  freePreset(handle: number): void;
  dispose(): void;
}
```

`PluginWorker` mirrors the shape of `WorkletProtocol` — a thin, testable class with a `MessagePortLike` constructor for fakes.

### 6.5 EngineClient orchestration

When `EngineClient.loadPlugin(...)` resolves (worklet's `INSTANCE_READY` received), the client also:

1. Spawns a `PluginWorker` for the same instance.
2. Waits for the worker's `READY`.
3. Stores `{ slot, worker }` in an internal `Map<instanceId, ...>`.

`preparePreset` looks up the worker by `instanceId`; `activatePreset` looks up the slot and posts to the worklet.

`unloadInstance` calls `worker.dispose()` then the existing worklet unload.

---

## 7. Demo plugin: sine adds a preset bank

The reference plugin extension lives in `src/builtin-plugins/sine/`:

- AS source gains `noa_preset_prepare`, `noa_preset_get_state_size`, `noa_preset_serialize`, `noa_preset_free`.
- Preset bytes format: 4 bytes magic (`'NSP1'` = Noa Sine Preset v1) + `f32` Volume + `f32` Octave + padding to 16 bytes.
- `noa_preset_prepare` busy-loops for 30 ms (configurable constant) to simulate parse cost.
- A handle is a 1-based slot index into a 4-slot fixed array of prepared presets.

The sine plugin's HTML UI gains a row of three preset buttons:

- `Bright`  → Volume=1.0, Octave=+1
- `Mellow`  → Volume=0.3, Octave=-1
- `Default` → Volume=0.5, Octave=0

Click handler:

1. Encode the preset bytes locally in JS.
2. `window.__noa.applyPreset(bytes)` (new bootstrap helper).
3. Bootstrap posts a control-lane message `PRESET_REQUEST { bytes }` to the parent iframe.
4. Parent routes to `EngineClient.preparePreset` → `activatePreset`.
5. Worklet swaps state. UI polls notify ring, sees the new param values, animates knobs.

For Phase 4 to *prove* the value we need both the synthetic delay and a measurable "audio didn't glitch" outcome. The plan's smoke checklist includes "hold a sustained note while clicking presets; no audible discontinuity."

---

## 8. File structure (delta from Phase 3)

**Create:**
- `src/engine/PluginWorker.ts` — main-thread façade
- `src/engine/plugin-host.worker.ts` — worker entry
- `src/engine/__tests__/PluginWorker.test.ts`
- `src/engine/__tests__/fixtures/preset-test/` — fixture plugin implementing v1.1 exports for unit tests
- `docs/plugin-abi-v1.md` — extended with the v1.1 section

**Modify:**
- `src/engine/PluginAbi.ts` — add v1.1 export name constants
- `src/engine/PluginInstance.ts` — add `setStateUnchecked(bytes)` helper used by `APPLY_PRESET_STATE` (the existing `setState` already works; just adding a clearer name)
- `src/engine/audio-worklet.ts` — handle `APPLY_PRESET_STATE` inbound
- `src/engine/EngineClient.ts` — orchestrate `PluginWorker` per instance; expose `preparePreset` / `activatePreset` / `freePreset`
- `src/engine/WorkletProtocol.ts` — add `applyPresetState(slot, bytes)` helper
- `src/engine/PluginUIProtocol.ts` — add `PRESET_REQUEST` (iframe → host) envelope
- `src/engine/PluginUIHost.ts` — bootstrap exposes `window.__noa.applyPreset(bytes)`
- `src/builtin-plugins/sine/src/index.ts` — add v1.1 exports + preset bank
- `src/builtin-plugins/sine/ui/index.html` — add preset buttons row
- `CLAUDE.md` — note the new module + ABI section
- `docs/superpowers/plans/2026-05-17-noa-daw-roadmap.md` — mark Phase 4 shipped

---

## 9. Testing

### 9.1 Vitest (Node)

- `PluginWorker.test.ts` — hand-rolled `MessagePortLike` exercises spawn/HELLO/PREPARE_PRESET/FREE_PRESET/dispose.
- `PluginInstance.test.ts` — extended with v1.1 round-trip: prepare → serialize → set_state on a separate instance → params match.
- Fixture: `src/engine/__tests__/fixtures/preset-test/` ships a small AS plugin implementing the v1.1 exports.

### 9.2 Manual browser smoke

- Click a preset button; audio doesn't glitch on a held note.
- Performance instrumentation: log the time between `PRESET_REQUEST` (iframe) and the worklet's `APPLY_PRESET_STATE` consumption. Target: < 50 ms on the synthetic delay.

### 9.3 What we intentionally don't test

- Real-time analysis (Phase 4b).
- Multi-instance preset library (one preset at a time per instance).
- Worker resilience to crashes — Phase 5 adds restart logic.

---

## 10. Risks and open questions

- **`noa_set_state` cost.** If plugin authors put non-O(memcpy) work here, the worklet glitches. The ABI section will document this requirement loudly; the design accepts that misbehaving plugins glitch.
- **Worker module transfer.** `WebAssembly.Module` is structured-cloneable but each clone in some engines forces a recompile. Chromium caches compiled modules across structured-clone — verify in the smoke test.
- **Worker startup cost.** Each `new Worker(...)` is ~5-20 ms. Spawning N workers at app boot inflates time-to-audio. Phase 4 accepts; Phase 5 may pool.
- **Preset bytes size bound.** Phase 4 places no explicit cap; bytes flow via `postMessage` (one copy per hop). Plugins should keep presets <1 MB to stay snappy.

---

## 11. Decisions explicitly rejected

- **Shared linear memory between RT and non-RT WASM instances.** Requires the WebAssembly threads proposal + careful `memory.shared = true` setup. Saves bytes per prepare but adds substantial complexity. v2.
- **Worker-managed voice allocation.** The roadmap explicitly asks "Voice allocation: stays with plugin, or moves to a host-level voice manager?" Phase 4 answer: stays with plugin. Voice management is per-instance and lives where the audio runs — in the worklet.
- **Direct Worker ↔ Worklet `MessageChannel` port transfer.** Possible (transfer a `MessagePort` from main thread to both ends) but main-thread relay is simpler for v1.
