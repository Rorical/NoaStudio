# Phase 3: WASM Plugin ABI v1 — Design Spec

**Status:** Design locked. Plan: `docs/superpowers/plans/2026-05-18-phase-3-plugin-abi-v1.md`.

**Predecessors:** Phase 1 (audio foundation) and Phase 2 (coordinator) shipped. The engine has a working `SharedArrayBuffer` event ring, an `AudioWorkletProcessor` with a hard-coded `SineGenerator`, and project state in a `SharedWorker`.

**This phase deletes the hard-coded generator and replaces it with a WASM-based plugin runtime — with a documented ABI, working preset state, and a floating HTML UI per instance.**

---

## 1. Goal

End-to-end demo at the end of Phase 3:

1. Open Noa.
2. The demo project loads. The signal chain is: `[sine plugin]` → `[gain plugin]` → output.
3. Click Play — hear a sine note pass through the gain stage.
4. Double-click the `Gain` entry in the Mixer's master FX rack — its UI opens as a floating window with a knob.
5. Drag the knob — audio level changes in real time.
6. Drag the master fader in the mixer — the open Gain window's knob updates to match (host → UI parameter sync).
7. Reload the page — the loaded plugins are restored from the coordinator's project state.

Everything in Phase 3 supports that scenario and nothing more. Multi-track routing, .noaplugin ZIP delivery, sidechain, modulation, and async plugin workers are all explicitly out of scope.

---

## 2. Out of scope (deferred to later phases)

- **Multi-track audio routing** — Phase 6. Phase 3 hosts a single linear signal chain in the worklet.
- **`.noaplugin` ZIP format and Service Worker delivery** — Phase 5. Phase 3 ships plugins as static folders under `src/builtin-plugins/`.
- **Plugin workers / async preset loading** — Phase 4. `noa_init` and friends run synchronously on the worklet in Phase 3.
- **Sample-accurate parameter automation** — out of scope. Parameter updates are quantized to block boundaries.
- **Hot reload of plugins** — out of scope.
- **Cross-plugin sidechain** — out of scope.
- **Per-instance meter publishing** — wired in Phase 4 alongside the oscilloscope example. Phase 3 reuses the existing master meter only.

---

## 3. Architecture overview

```
Main thread                            Worklet                          Iframe (per UI)
───────────                            ───────                          ──────────────
PluginRegistry                                                          plugin's index.html
  catalog of installed plugins
  fetches plugin.wasm + plugin.json
  compiles WebAssembly.Module
        │
        │ postMessage('INSTANTIATE_PLUGIN', {module, manifest, slot})
        ▼
EngineClient ──────────────────────▶  PluginRuntime (per instance)
  loadPlugin / unloadInstance         instantiates WebAssembly.Instance
  signal chain ops                    calls noa_init / noa_process / noa_destroy
        │                             owns event-routing for its instances
        │                                            ▲
PluginUIHost                                         │ events: param updates, NoteOn/Off
  per-instance iframe                                │ via existing event SAB ring (targetId)
  Blob URL same-origin                               │
  sandbox="allow-scripts"                            │
        │                                            │
        │ postMessage HELLO {paramRingSab,           │
        │   notifyRingSab, manifest, params}         │
        ▼                                            │
  Iframe ──── SAB writes (param ring) ──────────────┘
         ◀─── SAB reads (notify ring) ──── [worklet writes external param changes here]
```

The four moving pieces:

- **`PluginRegistry`** (main thread). Knows every installable plugin. Loads `plugin.wasm` + `plugin.json` from a URL, compiles the WASM, validates the manifest, holds a `WebAssembly.Module` ready for instantiation.
- **`PluginRuntime`** (worklet, one logical scope per instance). Wraps a `WebAssembly.Instance`. Owns the linear-memory layout pointers, drives `noa_process` each block, manages per-instance event routing.
- **`PluginUIHost`** (main thread). One iframe per open plugin window. Creates the Blob URL, sets up `postMessage` HELLO with the SAB references, tears down on close.
- **`PluginWindow`** (React, main thread). Floating-panel chrome (drag, resize, z-order, close button). Wraps any plugin's iframe.

---

## 4. ABI v1 specification

### 4.1 Exports (plugin → host)

| Symbol | Signature | Required | Purpose |
| --- | --- | --- | --- |
| `noa_abi_version` | `() -> u32` | yes | Returns `1`. Mismatch with host's expected version = refuse to load. |
| `noa_init` | `(sample_rate: u32, max_block_size: u32) -> u32` | yes | Allocate buffers; return `1` on success, `0` on failure. Called once per instance, before any other entry point. |
| `noa_get_audio_in_ptr` | `() -> u32` | yes (fx), unused (gen) | Stable pointer to interleaved-stereo `f32` input buffer of length `max_block_size * 2`. |
| `noa_get_audio_out_ptr` | `() -> u32` | yes | Stable pointer to interleaved-stereo `f32` output buffer of length `max_block_size * 2`. |
| `noa_get_event_buf_ptr` | `() -> u32` | yes | Pointer to events buffer (packed 32-byte `EngineEvent` frames). |
| `noa_event_buf_capacity` | `() -> u32` | yes | Frames the event buffer holds. Host caps writes to this number. |
| `noa_get_param_buf_ptr` | `() -> u32` | yes | Pointer to `f32[noa_param_count()]`. Host writes canonical param values before each `noa_process`. |
| `noa_param_count` | `() -> u32` | yes | Declared parameter count. |
| `noa_process` | `(n_frames: u32, n_events: u32) -> void` | yes | Read events + params + audio in; write audio out. Must be RT-safe. |
| `noa_state_size` | `() -> u32` | yes | Bytes required for a full preset snapshot. Returns `0` if plugin is stateless. |
| `noa_get_state` | `(out_ptr: u32) -> u32` | yes (if state_size > 0) | Write up to `noa_state_size()` bytes to `out_ptr`. Returns bytes actually written. |
| `noa_set_state` | `(in_ptr: u32, n_bytes: u32) -> u32` | yes (if state_size > 0) | Restore from bytes. Returns `1` on success, `0` on failure. |
| `noa_destroy` | `() -> void` | yes | Final cleanup before instance is dropped. |
| `memory` | `WebAssembly.Memory` | yes | Standard linear-memory export. All toolchains emit this by default. |

The host calls the `noa_get_*_ptr` exports **once after `noa_init`** and caches the results. Plugins must not relocate their internal buffers after `noa_init` returns.

### 4.2 Imports (host → plugin)

Plugins import a single namespace, `host`:

| Symbol | Signature | Purpose |
| --- | --- | --- |
| `host.log` | `(ptr: u32, len: u32) -> void` | Log a UTF-8 string from plugin memory. Host writes to `console.log` with a `[plugin:<id>]` prefix. |
| `host.random` | `() -> f64` | Returns `Math.random()`. |
| `host.get_tempo` | `() -> f32` | Returns the engine's current BPM. |

Plugins that don't need imports can omit them; the host still passes the full imports object — unused symbols are ignored.

### 4.3 Memory model

The plugin owns its linear memory. The host's interaction is strictly:

1. After `noa_init`, **once per instance:** read all `noa_get_*_ptr` and `noa_*_capacity` exports. Cache the four pointers.
2. **Each audio block, in order:**
   - Write the current canonical parameter array into the param buffer at `paramBufPtr`.
   - Write up to `noa_event_buf_capacity()` events into the event buffer at `eventBufPtr`. Capture the count as `n_events`.
   - For FX plugins, write the upstream slot's output samples into the input buffer at `audioInPtr` (length `n_frames * 2`).
   - Call `noa_process(n_frames, n_events)`.
   - Read `n_frames * 2` samples from the output buffer at `audioOutPtr`.
3. **Never write** anywhere else in the plugin's memory.

Generator plugins (`kind: "gen"`) should ignore `audioInPtr` and may declare it as 0; the host doesn't write input for generators.

### 4.4 Threading

- **`noa_process`** is called synchronously on the worklet's audio thread. No allocations, no system calls, no growing of `WebAssembly.Memory`. (Plugins should preallocate everything in `noa_init`.)
- **`noa_init` / `noa_destroy` / `noa_get_state` / `noa_set_state`** are called from main-thread → worklet via a control message. The worklet briefly pauses processing (drops samples for ≤ 1 block) to run these. Phase 4 moves them to a dedicated worker so audio never glitches; Phase 3 accepts the glitch.

### 4.5 Voice allocation

Plugin-side. The host emits raw `NoteOn` / `NoteOff` events via the event buffer; the plugin manages its own voice pool. The host does not implement voice stealing or anything like it.

### 4.6 ABI version negotiation

- Host's expected version: `ABI_VERSION = 1` (constant in `src/engine/PluginHost.ts`).
- Plugin's declared version: `manifest.abi_version` (must equal host's; otherwise the registry rejects on load) **and** `noa_abi_version()` (re-checked after instantiation; mismatch causes immediate `noa_destroy`).

Forward-compat policy: any breaking change to ABI v1 produces ABI v2; v1 plugins remain loadable as long as the host keeps a v1 PluginRuntime alongside the v2 one. We don't ship that compat code in Phase 3 — there is only v1.

---

## 5. Manifest schema (`plugin.json`)

```json
{
  "id": "com.noa.sine",
  "name": "Sine",
  "version": "1.0.0",
  "abi_version": 1,
  "kind": "gen",
  "params": [
    { "name": "Volume", "min": 0, "max": 1, "default": 0.5, "unit": "x", "display": "linear" },
    { "name": "Octave", "min": -2, "max": 2, "default": 0, "step": 1, "unit": "oct", "display": "linear" }
  ],
  "ui": { "entry": "index.html", "width": 280, "height": 180 }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Reverse-DNS unique identifier. Becomes the registry key. |
| `name` | `string` | Display name. |
| `version` | `string` | Semver. Informational; not used for loading decisions in Phase 3. |
| `abi_version` | `number` | Must equal `1`. |
| `kind` | `"gen" \| "fx"` | `gen` = instrument (no audio input). `fx` = effect (takes audio input). |
| `params` | `ParamDecl[]` | Order matches the `f32[]` indices in the param buffer. |
| `ui` | `{entry, width, height}?` | Optional. If absent, host renders an auto-UI from `params`. |

`ParamDecl` fields:
- `name`: `string` — display label.
- `min`, `max`: `number` — bounds.
- `default`: `number` — initial value.
- `step?`: `number` — quantization step. `0` or absent = continuous. `1` = integer.
- `unit?`: `string` — displayed alongside the value.
- `display?`: `"linear" | "log" | "db" | "hz" | "percent"` — UI hint for value mapping. Default `"linear"`.

---

## 6. Built-in plugin folder layout

For Phase 3, all plugins are first-party and shipped as static folders. ZIP-packaged plugins arrive in Phase 5.

```
src/builtin-plugins/<plugin-id-slug>/
├── plugin.json           manifest
├── plugin.wasm           built artifact (committed)
├── src/index.ts          AssemblyScript source
├── ui/                   optional HTML UI
│   └── index.html
├── asconfig.json         AssemblyScript build config
└── package.json          local build deps (asc)
```

Vite serves the folder as a static asset. The host fetches `plugin.json` and `plugin.wasm` via standard `fetch`. UI assets are read into memory and inlined as data URLs when constructing the iframe Blob URL.

**Two built-ins ship with Phase 3:**

- **`sine`** (kind `gen`) — replaces `SineGenerator.ts`. 8-voice polyphonic sine. Params: Volume, Octave. UI: a key-strip showing held notes + a volume knob.
- **`gain`** (kind `fx`) — simple gain stage. Params: Gain. UI: a single knob.

---

## 7. Toolchain: AssemblyScript

The roadmap mentioned Rust → WASM as an example; we override that choice for the reference plugins in favor of **AssemblyScript**:

- npm-installable, no foreign toolchain (`npm install --save-dev assemblyscript`).
- TypeScript-like syntax, familiar to the existing codebase.
- Produces small WASM (5–10 KB per example plugin).

The ABI is toolchain-agnostic. Any language that produces a linear-memory WASM module exporting the v1 symbols is a valid plugin. A Rust authoring guide can be added later without ABI churn.

**Build process for Phase 3:**

```bash
cd src/builtin-plugins/sine
npm install        # installs asc local to this plugin
npx asc src/index.ts -o plugin.wasm --runtime stub --optimize
```

The built `plugin.wasm` is **committed to the repo**. Rebuilding is optional and documented; CI doesn't run plugin builds in Phase 3.

A top-level npm script wraps both plugins:

```bash
npm run build:plugins   # cd into each plugin, run asc
```

---

## 8. Signal chain (Phase 3 scope)

Multi-channel routing is Phase 6. For Phase 3 the worklet hosts **one linear chain**:

```
[slot 0: generator] → [slot 1: insert FX] → [slot 2: insert FX] → ... → output
```

- Slot 0 is the generator. NoteOn/NoteOff events route here. Its audio output feeds slot 1.
- Slots 1..N are insert FX. Each slot's output feeds the next; the last slot's output is the worklet's audio output.
- Empty slots are skipped — the chain is essentially a `Vec<Option<PluginRuntime>>`.

The main thread mutates the chain via worklet control messages: `INSTANTIATE_PLUGIN { slot, module, manifest, instanceId }`, `DESTROY_INSTANCE { instanceId }`. The worklet applies them at block boundaries (it queues incoming messages and processes them between `noa_process` calls).

In the demo project, the chain is `[sine, gain]`. The Mixer UI lists `gain` as an entry in the master FX rack; double-clicking it opens its window.

---

## 9. Communication channels

### 9.1 Main thread ↔ worklet (control)

Existing `AudioWorkletNode.port` `postMessage` channel. New message types:

```
main → worklet:
  INSTANTIATE_PLUGIN { instanceId, slot, module, manifest }
  DESTROY_INSTANCE   { instanceId }
  CALL_GET_STATE     { instanceId, requestId }
  CALL_SET_STATE     { instanceId, requestId, bytes }
  CALL_NOA_INIT      (folded into INSTANTIATE_PLUGIN)

worklet → main:
  INSTANCE_READY  { instanceId, paramRingSab, notifyRingSab }
  INSTANCE_ERROR  { instanceId, error: string }
  STATE_RESPONSE  { requestId, bytes? }
```

### 9.2 Per-instance event ring (UI → worklet → plugin)

Phase 3 introduces a **per-instance event ring**: a new `RingBuffer` per `PluginRuntime`, allocated by the worklet at `INSTANTIATE_PLUGIN` time. The SAB is sent back to the main thread in `INSTANCE_READY` so the UI can write directly to it without a main-thread hop.

Frame format: existing `EngineEvent` 32-byte layout. Used for:
- `ParamSet { paramIndex, value }` — from the UI knob.
- `NoteOn` / `NoteOff` — from the playlist (initially still in the global ring; routed to instance 0 in Phase 3).

The worklet drains both the global event ring (routed by `targetId`) and the per-instance ring into the plugin's internal event buffer each block.

### 9.3 Per-instance notify ring (worklet → UI)

A second per-instance `RingBuffer`, written by the worklet, polled by the iframe at RAF rate via `Atomics.load`. Carries:

- `ParamChanged { paramIndex, value }` — when params change from sources other than this UI (mixer fader, automation, preset load).

Phase 3 wires `ParamChanged` only. Per-instance meter publishing is deferred to Phase 4.

### 9.4 Iframe ↔ host (control lane)

`postMessage` between iframe and parent.

```
host → iframe:
  HELLO {
    instanceId: string,
    abiVersion: 1,
    manifest: PluginManifest,
    initialParams: number[],
    paramRingSab: SharedArrayBuffer,
    notifyRingSab: SharedArrayBuffer,
  }
  STATE_RESTORE { bytes: Uint8Array }

iframe → host:
  READY {}
  STATE_SNAPSHOT_REQUEST { requestId: string }
  STATE_SNAPSHOT_RESPONSE { requestId: string, bytes: Uint8Array }
```

Parameter writes go directly into `paramRingSab` from the iframe — there's no slow `param-set` postMessage round-trip in the audio path.

---

## 10. Coordinator integration

Project state grows new shapes:

```ts
// projectModel.ts

interface PluginInstance {
  id: string;            // e.g. "inst_kf3"
  pluginId: string;      // matches PluginManifest.id
  bypass: boolean;
  params: number[];      // canonical values, indexed by ParamDecl order
}

interface Channel {
  // ...existing
  effects: PluginInstance[];    // was: { id, name, kind, bypass }[]
}

interface Track {
  // ...existing
  generator: PluginInstance | null;   // was: generator: string | null
}
```

Migration of existing `data.js`-seeded project: the seeder fills in `bypass`, defaults `params` from each plugin's manifest, generates fresh `id`s. The legacy `name`+`kind` fields in `Channel.effects` are dropped; `pluginId` is the source of truth now.

New actions:

```ts
| { type: 'load-plugin'; pluginId: string; into: { kind: 'channel-fx'; channelId: string }
                                                  | { kind: 'track-generator'; trackId: string }; insertAt?: number }
| { type: 'unload-plugin'; instanceId: string }
| { type: 'set-param'; instanceId: string; paramIndex: number; value: number }
| { type: 'set-instance-bypass'; instanceId: string; bypass: boolean }
```

The coordinator owns the canonical state. Worklet runtime is downstream — when state changes, the bridge sends `LOAD/UNLOAD_PLUGIN` to the worklet via the engine. Parameter SAB rings are the **fast path** for parameter updates inside an audio block; the coordinator is **only** updated when the user stops touching the knob (a debounced sync, or on knob "release"). Coordinator state is the source of truth for persistence, not for real-time DSP.

---

## 11. Testing

### 11.1 Unit tests (Vitest, Node)

- `PluginHost.test.ts` — Instantiate against a checked-in fixture WASM (built from a tiny dedicated test plugin under `src/engine/__tests__/fixtures/test-plugin/`). Test init → param round-trip → process → state snapshot → destroy.
- `PluginRegistry.test.ts` — Manifest parse, version check, registry register/lookup, reject invalid manifests.
- `PluginUIProtocol.test.ts` — `HELLO` envelope round-trip; reject malformed messages.
- `actions.test.ts` / `reducer.test.ts` — New actions reduce correctly.
- `sine.test.ts` and `gain.test.ts` — In Node, load the built plugin `.wasm`, run NoteOn / gain change, assert expected output.

### 11.2 Browser smoke test (manual)

End-of-phase script:

1. `npm run dev`, open localhost.
2. Click Play → hear a sine note (now coming from a WASM module, identical audibly to Phase 1).
3. Open the Mixer view.
4. Double-click the `Gain` entry in the master FX rack → window appears with a knob.
5. Drag the knob right → audio gets louder.
6. Drag the master fader right (separate from the plugin) → the plugin window's knob moves to match.
7. Refresh page → demo loads, plugins reload, audio still works.

### 11.3 What we deliberately don't test

- AudioContext-level integration (no jsdom audio worklet support, manual smoke test instead).
- Iframe cross-origin behavior (Vite dev serves same-origin; smoke-test verifies COOP/COEP holds).
- Performance / glitch-free init (Phase 4 addresses; Phase 3 accepts a brief silence on plugin instantiate).

---

## 12. Implementation phasing within Phase 3

The plan breaks Phase 3 into ~13 tasks:

1. Scaffold: `docs/plugin-abi-v1.md` + types + manifest schema parser.
2. PluginRegistry (manifest validation, version negotiation, WASM compile).
3. Fixture WASM module + PluginHost unit tests (lifecycle, params, audio I/O, state).
4. PluginHost class — main-thread plugin instance management primitive (used by tests; the worklet will create its own analogue).
5. Worklet PluginRuntime + per-instance event/notify rings + chain processing.
6. EngineClient `loadPlugin` / `unloadInstance` plumbing + control-message protocol.
7. Coordinator: PluginInstance type, actions, reducer updates, project model migration.
8. Wire the worklet to drive plugins instead of `SineGenerator`. Replace `SineGenerator.ts`.
9. AssemblyScript scaffolding + the `sine` built-in plugin (no UI yet).
10. The `gain` built-in plugin (no UI yet).
11. PluginUIHost iframe lifecycle + PluginUIProtocol envelope.
12. PluginWindow React chrome + Mixer integration (double-click → open).
13. Plugin UI HTML for `sine` and `gain`. End-to-end smoke test. Documentation pass.

The plan doc spells out files-to-touch / failing-tests-first / commit-per-task for each.

---

## 13. Risks and open questions

- **AssemblyScript runtime size.** Default AS runtime ships GC; we use `--runtime stub` to disable it (no GC, just bump allocation). Acceptable for stateless DSP. If a plugin needs GC, it should use a different toolchain.
- **Synchronous init blocks audio.** Brief silence (≤ 1 block ~ 3ms at 48k/128) when a plugin instantiates. Phase 4 fixes this with a worker.
- **WebAssembly.Module structured-clone to worklet.** Verified supported in Chromium; confirm via early smoke test in Task 5.
- **Iframe `crossOriginIsolated` propagation.** A same-origin Blob iframe inside a COOP/COEP page inherits the agent cluster, so `SharedArrayBuffer` postMessage works. Confirmed by spec, verified by smoke test in Task 11.
- **Iframe sandbox + Blob URLs.** `sandbox="allow-scripts"` without `allow-same-origin` still loads same-origin Blob URLs and inherits `crossOriginIsolated`. Confirm in Task 11 smoke.

---

## 14. Decisions explicitly rejected

- **Rust as the v1 reference-plugin toolchain.** Mentioned in the roadmap but not load-bearing. AssemblyScript is the npm-native choice. A Rust guide can come later.
- **Pre-block parameter smoothing in the host.** Plugins do their own smoothing if they want it; the host treats params as block-rate.
- **Sample-accurate parameter automation events.** Out of scope for v1; quantized to block boundaries.
- **Plugin-to-plugin direct communication.** Out of scope; plugins communicate only via audio + the host.
- **Persistent per-instance UI state across reloads.** Phase 3 restores plugin state via `noa_set_state`; UI-only state (panel collapsed, knob fine-tune mode) is lost on reload. The roadmap's "piggyback on `noa_get_state`" suggestion is documented for plugin authors but not enforced.
