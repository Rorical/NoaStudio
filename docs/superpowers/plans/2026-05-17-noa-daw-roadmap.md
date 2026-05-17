# Noa Studio: Real DAW Roadmap

**Status:** Planning. The current codebase is a view-only React mockup; everything below is forward-looking.

**End-state goal:** A browser-based DAW with a real audio engine, sample-accurate event delivery, customizable WASM plugins, and the existing FL-Studio-style UI driven by engine state instead of simulation.

**Target platform:** Chromium-only. Plan freely uses `SharedWorker`, `SharedArrayBuffer`, `Atomics`, `AudioWorklet`, COOP/COEP. No graceful degradation.

**Plugin ABI:** Custom Noa ABI — linear-memory WASM modules with hand-designed exports/imports + JSON metadata sidecar.

---

## Phase 1 — Audio foundation

**Delivers:** A working real-time audio path from React UI down to `AudioWorkletProcessor`, with sample-accurate event delivery and round-trip meter telemetry.

**Detailed plan:** `2026-05-17-phase-1-audio-foundation.md`

**Components introduced:**
- `src/engine/RingBuffer.ts` — SPSC ring buffer over `SharedArrayBuffer`, lock-free via `Atomics`. The foundational IPC primitive for every later phase.
- `src/engine/EngineEvent.ts` — Binary event format (32-byte frames): `NoteOn`, `NoteOff`, `ParamSet`, `Transport`, `Tempo`. Frame-offset field gives sample-accurate timing within an audio block.
- `src/engine/dsp/SineGenerator.ts` — Headless DSP class (no AudioWorklet dependency, fully unit-testable). Built-in test instrument for Phase 1; deleted in Phase 3 once real plugins exist.
- `src/engine/audio-worklet.ts` — `AudioWorkletProcessor` that drains the event ring, runs the generator, writes peak/RMS to a meter ring, advances a sample-counter telemetry SAB.
- `src/engine/EngineClient.ts` — Main-thread façade. Owns `AudioContext` and the `AudioWorkletNode`, exposes `noteOn`/`noteOff`/`play`/`stop`/`readMeters`/`currentSamplePosition`.
- COOP/COEP headers in `vite.config.js` (required for `SharedArrayBuffer` in cross-origin-isolated contexts).
- Vitest + TypeScript scoped to `src/engine/` only — React UI stays JSX.

**Demo at end of phase:** Click Play in the existing UI → hear a sustained sine. Master meter in `Toolbar` reflects real RMS (not simulation). `time` advances from the engine's sample counter, not from a RAF loop.

**Decisions locked in this phase:**
- Ring buffer layout: 16-byte header (`writeIdx`, `readIdx`, `capacity`, `frameSize`), power-of-2 slot count, monotonic indices with masking on access.
- Event frame size: 32 bytes (1 type + 1 flags + 2 reserved + 4 frame-offset + 24 payload). Big enough for `f64` positions, small enough that 1024-slot ring = 32KB.
- Meter frame size: 16 bytes (`channelId u32`, `peak f32`, `rms f32`, `blockCounter u32`).
- Coordinate system: time is **beats** in user-facing APIs, **samples** in the engine. Engine owns the canonical sample counter; main thread converts via `sampleRate` and `bpm`.

---

## Phase 2 — App coordinator (SharedWorker)

**Delivers:** Project state — tracks, clips, channels, patterns, transport — lives in a `SharedWorker`. The main thread is a thin view that subscribes to state and dispatches intents.

**Components introduced:**
- `src/coordinator/coordinator.worker.ts` — `SharedWorker` entry. Owns the `Project` (immutable snapshots, structural sharing). Routes events into Phase 1's event ring (or, eventually, into per-plugin worker rings).
- `src/coordinator/protocol.ts` — Message types: `Subscribe`, `Snapshot`, `Patch`, `Dispatch(action)`. Patches are JSON-Patch-shaped for efficient diffing.
- `src/coordinator/ProjectStore.ts` — Reducer + history (undo/redo) for the project model. Pure functions, no DOM, fully testable.
- `src/coordinator/ClientBridge.ts` — Main-thread adapter: connects to the `SharedWorker`, exposes a React-friendly `useProject()` hook with selector memoization.
- Refactor of `App.jsx`: replace `useState` for tracks/clips/channels with `useProject(selector)` and `useDispatch()`. State seeds now come from the coordinator, not `data.js` directly.

**Demo at end of phase:** Open Noa in two browser tabs simultaneously. Edit a clip in tab A; tab B's playlist updates within one frame. Undo works across both.

**Decisions to make in this phase's spec:**
- Project model schema (immutable representation; how patterns/automations are stored).
- Action vocabulary (every state change goes through a typed action).
- How the coordinator decides which worker each event goes to (becomes critical in Phase 4).
- Persistence: IndexedDB vs OPFS for project files.

---

## Phase 3 — WASM plugin ABI v1

**Delivers:** A documented `.noaplugin` package format and a host runtime in the AudioWorklet that can load, instantiate, and process audio through a third-party WASM plugin. The Phase 1 sine generator is replaced by a built-in WASM module compiled from a sample plugin source.

**Components introduced:**
- `docs/plugin-abi-v1.md` — Authoritative spec. Linear-memory layout, required exports (`noa_init`, `noa_process`, `noa_param_count`, `noa_param_info`, `noa_state_size`, `noa_get_state`, `noa_set_state`), available host imports (`host_log`, `host_random`, `host_get_tempo`).
- `.noaplugin` format: ZIP containing `plugin.wasm` + `plugin.json` (metadata: name, version, port count, parameter declarations, GUI bundle reference).
- `src/engine/PluginHost.ts` — Instantiates a WASM module against a fresh `WebAssembly.Memory`, sets up imports, owns the plugin's linear-memory layout (input buffer ptr, output buffer ptr, event queue ptr, param block ptr).
- `src/engine/audio-worklet.ts` extensions — Per-track plugin instance lookup, calling `noa_process` per block with shared linear-memory pointers. Polyphonic voice allocation moves into the plugin, not the host.
- `examples/plugins/gain/` — Reference plugin, Rust + `wasm-bindgen`-free hand-rolled, ~100 LoC. Builds to `gain.noaplugin`.
- `examples/plugins/sine/` — Replacement for `SineGenerator.ts`. Now a real plugin.

**Demo at end of phase:** Drag the `Sine` plugin from the Browser onto a track; play → hear sine. Drag the `Gain` plugin onto the master channel; drag the fader → audible gain change.

**Decisions to make in this phase's spec:**
- Memory model: does the host or plugin own the audio buffers? (Recommend: host preallocates, passes pointers each block.)
- Threading model: is `noa_process` called from inside the worklet (synchronous, RT-safe) or marshalled to a dedicated worker? Phase 3 = synchronous in worklet; Phase 4 explores split.
- Parameter contract: continuous floats, discrete enums, modulation sources.
- ABI version negotiation and forward-compatibility rules.

---

## Phase 4 — Plugin host workers

**Delivers:** Plugins that can do heavy non-RT work (preset loading, FFT analysis, GUI state) without glitching audio. The RT path stays in the worklet; non-RT work moves to a dedicated `Worker` per plugin instance.

**Components introduced:**
- `src/engine/plugin-host.worker.ts` — Per-plugin-instance worker. Holds the canonical plugin state (a second WASM instance, or shared memory with the RT instance — TBD in spec).
- `src/engine/AsyncMessageRing.ts` — Separate SAB ring for non-RT messages between plugin worker and worklet (lower priority than the RT event ring).
- Plugin ABI v1.1: optional async exports (`noa_load_preset`, `noa_render_offline`) callable only from the worker side.
- A worked example: an oscilloscope plugin where the worklet writes audio samples to a meter-like SAB, the worker reads them, computes a downsampled waveform, and posts it to the main thread for rendering.

**Demo at end of phase:** Load a synth plugin that has a 50ms preset-load time. Switch presets while audio is playing; no audio glitch, no UI freeze.

**Decisions to make in this phase's spec:**
- Worker-per-instance vs worker-pool (one worker hosting N plugins).
- Whether plugin GUI runs on main thread (canvas/DOM) or in the worker with `OffscreenCanvas`.
- Voice allocation: stays with plugin, or moves to a host-level voice manager?

---

## Phase 5 — Service Worker delivery

**Delivers:** Plugins installed from URLs, cached offline, served with COEP-compatible headers, isolated from the main origin.

**Components introduced:**
- `src/sw/plugin-cache.sw.ts` — Service Worker that intercepts `/plugins/*` requests, serves from a Cache Storage entry, falls through to network for misses. Adds `Cross-Origin-Resource-Policy: same-origin` so the bundles can be loaded under COEP.
- `src/coordinator/PluginRegistry.ts` — Coordinator-owned: tracks installed plugins, their bundle URLs, version/integrity hashes. Exposes `installPlugin(url)`, `removePlugin(id)`, `listInstalled()`.
- Browser sandbox: `.noaplugin` archives served from a dedicated subpath, integrity-checked via Subresource Integrity (SRI) hashes recorded in the registry.
- Virtual file system shim — Service Worker also serves `/project-assets/*` URLs that resolve to IndexedDB/OPFS-backed project data, letting plugins reference samples via URLs without exposing the filesystem.

**Demo at end of phase:** Paste a plugin URL into the Browser pane; "Install" button. Reload the page with network disabled; the plugin is still there and works.

**Decisions to make in this phase's spec:**
- Registry: anyone can publish, or curated list?
- Update strategy: pinned versions, semver ranges, auto-update?
- Permissions model for plugins requesting filesystem/MIDI/network access.

---

## Phase 6 — UI ↔ engine wiring

**Delivers:** The existing React UI is fully backed by engine + coordinator state. All `data.js` demo seeds, the simulated meter loop, and the simulated transport in `App.jsx` are removed.

**Work involved:**
- `App.jsx`: delete the two RAF loops (transport + meter sim). Subscribe to coordinator project + engine telemetry.
- `Playlist.jsx`: clip drag → dispatches `MoveClip` action to coordinator instead of mutating `clips` state.
- `PianoRoll.jsx`: note edits → `EditPattern` actions; live playhead reads from engine sample counter.
- `Mixer.jsx`: fader/pan → `SetParam` events to engine; meters → `engine.readMeters()`.
- `Toolbar.jsx`: Play/Stop → engine transport events; BPM → `Tempo` event.
- Persistence: project autosaves via coordinator to OPFS. Open/Save UI ties to actual files.
- A `WaveformView` for audio clips that reads real PCM data from the audio worker (Phase 4 oscilloscope path repurposed).

**Demo at end of phase:** Load a saved project (or the bundled demo). Hit play. Hear the actual demo song with real plugins. Mute/solo/fader changes are audible. Save, reload, restore.

**Decisions to make in this phase's spec:**
- Selector strategy for `useProject` (avoid re-rendering all of `Playlist` on every meter tick).
- Optimistic vs pessimistic UI for drag operations (clip drag preview during a long round-trip).
- File-format compat between the in-memory project model and on-disk `.noa` files.

---

## Cross-cutting concerns (decided up-front, refined per phase)

**Build & dev:**
- Vite stays. TypeScript added but scoped to `src/engine/`, `src/coordinator/`, `src/sw/` — the React UI remains JSX with optional JSDoc until Phase 6.
- `?worker` and `new URL(..., import.meta.url)` for worker/worklet entry points (Vite's native pattern).

**Testing:**
- Vitest for unit tests (engine primitives, event encoding, reducers).
- Manual browser smoke tests for anything that touches `AudioContext` — no jsdom polyfill for audio worklets.
- An optional Playwright suite later for end-to-end UI flows (after Phase 6).

**No incremental UI regressions:**
- Every phase keeps the existing UI clickable. Phase 1 adds engine output behind the existing Play button; Phase 2 replaces state with coordinator-backed state but keeps the same component tree; Phases 3–5 are mostly behind-the-scenes.

**What we are deliberately not doing:**
- No MIDI input (WebMIDI) in v1 — focus is on the internal sequencer + plugin chain.
- No multi-track audio recording in v1 — playback engine first, recording later.
- No VST/AU/CLAP host bridge — custom WASM ABI only, by design.
- No cloud sync, no accounts, no telemetry — local-first.
