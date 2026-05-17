# Noa Studio: Real DAW Roadmap

**Status:** Planning. The current codebase is a view-only React mockup; everything below is forward-looking.

**End-state goal:** A browser-based DAW with a real audio engine, sample-accurate event delivery, customizable WASM plugins (with optional bundled HTML UIs that float as draggable, VST-style sub-windows), and the existing FL-Studio-style UI driven by engine state instead of simulation.

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

**Delivers:** A documented `.noaplugin` package format and a host runtime that can load, instantiate, and process audio through a third-party WASM plugin — *with* a floating, draggable HTML UI per instance, communicating with the audio core in real time. The Phase 1 sine generator is replaced by a built-in WASM module compiled from a sample plugin source.

**Components introduced:**

*Audio side:*
- `docs/plugin-abi-v1.md` — Authoritative spec. Linear-memory layout, required exports (`noa_init`, `noa_process`, `noa_param_count`, `noa_param_info`, `noa_state_size`, `noa_get_state`, `noa_set_state`), available host imports (`host_log`, `host_random`, `host_get_tempo`).
- `.noaplugin` format: ZIP containing `plugin.wasm` + `plugin.json` (manifest: name, version, port count, parameter declarations, optional `ui: { entry, width, height, resizable }`) + optional `ui/` directory with `index.html` and any referenced assets.
- `src/engine/PluginHost.ts` — Instantiates a WASM module against a fresh `WebAssembly.Memory`, sets up imports, owns the plugin's linear-memory layout (input buffer ptr, output buffer ptr, event queue ptr, param block ptr).
- `src/engine/audio-worklet.ts` extensions — Per-track plugin instance lookup, calling `noa_process` per block with shared linear-memory pointers. Polyphonic voice allocation moves into the plugin, not the host.

*UI side:*
- `src/engine/PluginUIHost.ts` — Per-instance iframe lifecycle. Builds a Blob URL from the plugin's `ui/index.html` (assets inlined as data URLs for v1; Phase 5 replaces this with a Service Worker virtual FS for multi-asset bundles). Creates a same-origin `<iframe sandbox="allow-scripts">` (no `allow-same-origin` → can't reach `window.top`, can't read cookies; same-origin Blob still lets us share SAB references). Hands two SABs to the iframe over `postMessage` after `load`: a parameter ring (UI→core: writes parameter changes) and a notification ring (core→UI: writes parameter changes from automation, mixer fader, etc., plus meter/scope data).
- `src/engine/PluginUIProtocol.ts` — The `postMessage` envelope schema (control lane). Messages: `hello`/`ready` handshake, `param-set`, `param-changed`, `state-snapshot`/`state-restore`, `meter-subscribe`/`meter-unsubscribe`. All structured-clone-safe.
- `src/components/PluginWindow.jsx` — Floating-panel chrome around the iframe: drag, resize, z-order, minimize/close. Reuses the position/clamp pattern from `TweaksPanel.jsx`. Generic — wraps any plugin's iframe; the plugin's HTML draws inside.
- `examples/plugins/gain/` — Reference plugin, hand-rolled Rust → WASM (~100 LoC) + a small HTML UI: one knob (raw `<input type="range">` + CSS), reads/writes the param SAB at RAF rate. Builds to `gain.noaplugin`.
- `examples/plugins/sine/` — Replacement for `SineGenerator.ts`. Real plugin with a minimal UI (note selector, optional ADSR).

**UI host contract (locked decisions):**
- **Origin:** same-origin Blob URL. `crossOriginIsolated` is preserved, so `SharedArrayBuffer` passes through `postMessage` to the iframe.
- **Sandbox:** `sandbox="allow-scripts"` — no `allow-same-origin`, no `allow-top-navigation`, no `allow-forms`. Plugins can run JS but can't escape into the host DOM or navigate the page.
- **Comms — two lanes:**
  - *Control lane* (`postMessage`): low-rate, JSON-shaped messages. Used for parameter set/get, preset load, state snapshot/restore, opening/closing the UI. Easy to debug, easy to log, easy to record for tests.
  - *Real-time lane* (SAB ring buffers): parameter automation curves, meter data, scope/spectrum visuals. UI subscribes once via control lane (`meter-subscribe { kind, slot }`), then polls the SAB at RAF rate using `Atomics.load`. Parameter writes from the UI go straight into the audio worklet's event ring via a dedicated UI→engine ring per instance — sample-accurate by construction, no main-thread hop.
- **Parameter sync:** the canonical state lives in the WASM instance's linear memory. UI changes flow UI→ring→worklet→plugin. External changes (mixer fader, automation, host preset load) flow plugin→core→notification-ring→UI. UIs are pure views — they don't store parameter state themselves beyond what they render.
- **Lifecycle:** the iframe is created when the user opens the plugin window and destroyed on close. Closing the UI does NOT unload the plugin or stop audio. Reopening re-creates the iframe and replays the current parameter snapshot. UIs can save their own view-state (collapsed sections, zoom levels) by piggybacking on `noa_get_state` via a manifest-declared `ui_state_bytes` field.
- **Headless plugins:** plugins without a `ui` manifest field get a generic auto-UI built from parameter metadata — same `PluginWindow` chrome, but the host renders the knobs from `noa_param_info`. Means "ship just a WASM" is a valid plugin shape.

**Demo at end of phase:** Drag the `Sine` plugin from the Browser onto a track; play → hear sine. Drag the `Gain` plugin onto the master channel. Double-click the plugin in the Mixer FX rack → its HTML UI opens as a floating window with a knob. Drag the knob → audio gain changes in real time. Drag the mixer's master fader → the plugin window's knob updates instantly to match.

**Decisions to make in this phase's spec (everything else is already locked above):**
- Memory model: does the host or plugin own the audio buffers? (Recommend: host preallocates, passes pointers each block.)
- Threading model: is `noa_process` called from inside the worklet (synchronous, RT-safe) or marshalled to a dedicated worker? Phase 3 = synchronous in worklet; Phase 4 explores split.
- Parameter contract: continuous floats, discrete enums, modulation sources.
- ABI version negotiation and forward-compatibility rules.
- v1 asset bundling: inline-all-assets-as-data-URLs (simplest, breaks for plugins with many large assets) vs unpack-into-OPFS-on-install (more complex but no size cliff). MVP picks inline; Phase 5 supersedes.

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
- Optional `OffscreenCanvas` transfer from the plugin UI iframe → plugin worker, for plugins that want to render heavy visualizations (spectrum, scope) off the main thread. Plugin GUI itself stays in the iframe; only the rendering surface can move.
- Voice allocation: stays with plugin, or moves to a host-level voice manager?

---

## Phase 5 — Service Worker delivery

**Delivers:** Plugins installed from URLs, cached offline, served with COEP-compatible headers. Crucially, this phase replaces Phase 3's inline-data-URL UI bundling with a real virtual filesystem, so plugin UIs can ship arbitrary assets (multiple HTML files, CSS imports, fonts, large SVG/PNG art, dynamic `import()`s).

**Components introduced:**
- `src/sw/plugin-cache.sw.ts` — Service Worker that intercepts three URL spaces:
  - `/plugins/<id>/<version>/wasm` — the `.noaplugin`'s `plugin.wasm`. Served with `application/wasm` and COEP-compatible headers.
  - `/plugin-ui/<instance-id>/<path>` — the plugin's UI assets. Per-instance scoping so two instances of the same plugin don't share a window object. The iframe's Blob URL is replaced with `<iframe src="/plugin-ui/<instance-id>/index.html">`, and the SW resolves every same-origin fetch from the iframe against the unpacked `.noaplugin` ZIP.
  - `/project-assets/<id>/<path>` — IndexedDB/OPFS-backed project data, so plugins can reference samples via URLs without filesystem APIs.
  All three serve with `Cross-Origin-Resource-Policy: same-origin` so they load under COEP.
- `src/coordinator/PluginRegistry.ts` — Coordinator-owned: tracks installed plugins, their bundle URLs, version/integrity hashes, and unpacked-asset roots in OPFS. Exposes `installPlugin(url)`, `removePlugin(id)`, `listInstalled()`. On install: download → SRI-verify → unzip → write `plugin.wasm` and `ui/` to OPFS under the plugin's content-addressed root.
- `src/engine/PluginUIHost.ts` updates — When the SW is registered, switch from Blob URLs to `/plugin-ui/<instance-id>/index.html`. Falls back to Phase-3 Blob URLs if the SW failed to register (e.g., in dev without HTTPS).
- Browser sandbox: `.noaplugin` archives served from a dedicated subpath, integrity-checked via Subresource Integrity (SRI) hashes recorded in the registry.

**Demo at end of phase:** Paste a plugin URL into the Browser pane; "Install" button. Plugin's UI uses three external CSS files and a custom font — all serve from the SW cache, no network. Reload the page with network disabled; the plugin is still there, its UI still themes correctly, and audio still works.

**Decisions to make in this phase's spec:**
- Registry: anyone can publish, or curated list?
- Update strategy: pinned versions, semver ranges, auto-update?
- Permissions model for plugins requesting filesystem/MIDI/network access.
- Asset lifetime for closed-window plugins: keep the unpacked OPFS root forever (cheap, but accumulates) or evict on uninstall + LRU when over quota?

---

## Phase 6 — UI ↔ engine wiring

**Delivers:** The existing React UI is fully backed by engine + coordinator state. All `data.js` demo seeds, the simulated meter loop, and the simulated transport in `App.jsx` are removed.

**Work involved:**
- `App.jsx`: delete the two RAF loops (transport + meter sim). Subscribe to coordinator project + engine telemetry.
- `Playlist.jsx`: clip drag → dispatches `MoveClip` action to coordinator instead of mutating `clips` state.
- `PianoRoll.jsx`: note edits → `EditPattern` actions; live playhead reads from engine sample counter.
- `Mixer.jsx`: fader/pan → `SetParam` events to engine; meters → `engine.readMeters()`. Double-clicking an FX-rack entry (or its "open editor" button) opens that plugin instance's `<PluginWindow>` from Phase 3 — the mixer is the canonical entry point for plugin UIs.
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
