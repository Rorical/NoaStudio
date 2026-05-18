# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Vite dev server on port 5173 (see `vite.config.js`).
- `npm run build` — production build to `dist/`.
- `npm run preview` — serve the built `dist/` for smoke-testing.

- `npm test` — Vitest unit tests (Node environment, no browser). All 147 tests across 15 suites (engine + coordinator + built-in plugins) should pass.
- `npm run build:plugins` — Optional. Rebuilds the AssemblyScript-authored plugins in `src/engine/__tests__/fixtures/` and `src/builtin-plugins/`. The compiled `.wasm` artifacts are committed; this script is only needed after editing a plugin's AS source.
- `npm run typecheck` — TypeScript type check (`tsc --noEmit`).

For UI changes, run `npm run dev` and click through.

## Architecture

Noa Studio is a browser-based DAW under active construction. As of Phase 3, audio is produced by **WASM plugins** loaded through the Noa Plugin ABI v1 (see `docs/plugin-abi-v1.md`). Two built-in plugins ship in `src/builtin-plugins/`: `com.noa.sine` (8-voice polyphonic sine generator) and `com.noa.gain` (linear gain insert). Each plugin can ship a floating HTML UI hosted in a sandboxed iframe. Project state (tracks, clips, channels, BPM, loop, metronome, plugin instances) lives in a `SharedWorker` in `src/coordinator/`, persisted to OPFS. Per-channel mixer meters are still simulated; multi-track audio routing arrives in Phase 6 — see `docs/superpowers/plans/2026-05-17-noa-daw-roadmap.md`.

### State lives in App.jsx

`src/App.jsx` is the single source of truth. It owns `tracks`, `clips`, `channels`, transport state (`playing`, `recording`, `bpm`, `time`), selection, view toggles, and `levels`. All child components are presentational — they receive data + callbacks as props and never own domain state. When adding behavior, mutate state in `App.jsx` and pass a new callback down; don't create local stores or contexts.

Initial state seeds come from `src/data.js` (`DEMO_TRACKS`, `DEMO_CLIPS`, `DEMO_CHANNELS`, `PLUGINS`, `FILES`, `TRACK_COLORS`). Editing `data.js` is the supported way to change the starting project.

### The two-loop time model

Two independent `requestAnimationFrame` loops run in `App.jsx`:

1. **Transport loop** (depends on `playing`, `bpm`, `loop`): reads `engine.currentSamplePosition()` from a `Uint32Array` backed by a `SharedArrayBuffer` that the audio worklet atomically writes each block. The main-thread RAF converts sample count → seconds → beats using `bpm`. When `loop` is on, the loop wraps at beat 32 by re-anchoring `samplesAtPlayStartRef` and `timeAtPlayStartRef` to the current position. Hard-stops at beat 128 otherwise. The elapsed-samples math uses `>>> 0` to remain correct across the ~24.9h uint32 wrap.
2. **Meter loop** (always running): reads real engine data for the **Master** channel — calls `engine.readMeters()`, drains all queued frames, and picks the max `peak` per RAF tick for `levels['m0']`/`levels['m0_r']`. Other channel meters (`Kick`, `Snare`, `Hats`, etc.) are still simulated via `sin()`/`Math.random()` keyed off the current beat and channel name — those stay until Phase 6.

Time is always in beats internally. The Toolbar converts to bars:beats:ticks and to a wall clock using `bpm`.

### Track ↔ Channel coupling

`track.channel` is an integer; the corresponding mixer strip's id is `'m' + track.channel`. `toggleTrackMute` / `toggleTrackSolo` in `App.jsx` mirror the change onto the channel (via `toggleMute('m' + tr.channel)`). If you add new tracks, keep this convention or the mute/solo from the playlist won't reach the mixer.

Special channel ids: `m0` is Master; ids starting with `mB` are drum buses, `mR` are reverb buses (used for CSS variant styling in `Mixer.jsx`).

### Drag-and-drop wiring

The Browser pane writes a serialized plugin object onto the drag event:
`e.dataTransfer.setData('plugin', JSON.stringify(p))`. Drop targets parse it back:

- **Playlist track header** → `kind === 'gen'` → `onAssignGenerator(trackId, name)` sets the track's generator and forces `type: 'midi'`.
- **Mixer channel strip or FX panel** → `kind === 'fx'` → `onAddEffect(channelId, plugin)` appends an effect with a new random id.

Both endpoints live in their respective components; the data contract is just the `{name, kind, tag}` shape from `PLUGINS`.

### Clip model and the piano roll

Clips are either audio (`clip.audio === true`, rendered as fake `ClipWaveform`) or MIDI (`clip.pattern.notes` rendered as `ClipMidiPreview`). MIDI notes are stored as compact tuples `[beat, pitch, length]` in `data.js` and inside `clip.pattern.notes`. The `PianoRoll` component inflates them to `{id, beat, pitch, length, velocity}` for editing and serializes back to tuples via `onUpdateNotes` on every change.

`PianoRoll` will auto-grow the parent clip's `length` (rounded up to the next bar) when a note is drawn or dragged past the end, via `onUpdateLength` → `updateClipLength` in `App.jsx` (which only grows, never shrinks).

Layout constants are component-local and intentionally hardcoded — `Playlist`: `BEAT_PX = 26`, `BAR_BEATS = 4`, `TOTAL_BEATS = 128`, `TRACK_H = 56`. `PianoRoll`: `PR_BEAT_W = 56`, `PR_KEY_H = 14`, `PR_OCTAVES = 4` (48 keys, ~C3–C7). Changing these cascades through positioning math.

### Styling

Two CSS files imported in `main.jsx`:
- `src/styles/styles.css` — Material 3 design tokens (`--m3-*`) for `[data-theme="dark"]` and `[data-theme="light"]`, plus layout/shell.
- `src/styles/styles-components.css` — per-component styles (toolbar, playlist, mixer, piano roll, browser, etc.).

The theme is switched by `App.jsx` setting `data-theme` on `document.documentElement` (see the `useEffect` on `theme`). Component CSS uses `--track` as a per-instance custom property — components set it inline via `style={{ '--track': color }}` so the same class can be tinted per-track. Preserve that pattern when adding track-aware UI.

`TweaksPanel.jsx` is an exception: it ships its own inline `<style>` block (`TWEAKS_STYLE`) instead of using the global stylesheets. Keep tweak-panel CSS local to that file.

### Icons

`src/components/Icon.jsx` is a flat lookup of inline SVG `<path>`/`<g>` nodes keyed by name. To add an icon, add an entry to the `ICONS` map — don't reach for an icon library.

### Engine module (`src/engine/`)

TypeScript module, isolated from the JSX UI. Communicates with the React tree via the `useEngine()` hook in `src/engine/useEngine.js`.

**Core infrastructure:**
- `RingBuffer.ts` — SPSC ring buffer over `SharedArrayBuffer`. Header layout: `[writeIdx, readIdx, capacity, frameSize]` as a `Uint32Array`. Capacity is power-of-2; indices are monotonic and masked on slot lookup.
- `EngineEvent.ts` — 32-byte binary event frames (`NoteOn`, `NoteOff`, `ParamSet`, `Transport`, `Tempo`). `frameOffset` field gives sample-accurate timing within an audio block.
- `audio-worklet.ts` — `AudioWorkletProcessor` shim. Drives a `PluginChain` (signal chain), drains the global event ring routing frames to chain slots by `targetId`, publishes per-block meter frames and a sample-counter telemetry SAB.
- `EngineClient.ts` — Main-thread façade. Owns the `AudioContext` + `AudioWorkletNode`. Requires `crossOriginIsolated === true` (enforced by COOP/COEP headers in `vite.config.js`). Exposes `loadPlugin` / `unloadInstance` (via `WorkletProtocol`) and `setParam` / `noteOn` / etc.

**Plugin ABI v1 — see `docs/plugin-abi-v1.md` for the authoritative author-facing spec:**
- `PluginAbi.ts` — `ABI_VERSION = 1` constant + table of export symbol names. Toolchain-agnostic.
- `PluginManifest.ts` — Manifest schema validator. Manifests carry `id`, `name`, `version`, `abi_version`, `kind: 'gen' | 'fx'`, `params: ParamDecl[]`, optional `ui: { entry, width, height }`.
- `PluginInstance.ts` — One running WASM plugin. Sync `fromModule(module, manifest, opts)` for the worklet; async `fromBytes` for Node-based tests. When constructed with `allocateRings: true` the instance owns per-instance event/notify SAB rings exposed as public fields. Methods: `setParam`, `readParam`, `pushEvents`, `writeInput`, `readOutput`, `process`, `getState`, `setState`, `drainParamRing`, `pushNotifyParamChanged`, `destroy`.
- `PluginChain.ts` — Linear signal chain hosted by the worklet. `install(slot, instance)` / `uninstall(slot)` / `queueEventFrame(slot, frame)` / `processBlock(blockSize, outBus)`. Slot 0 conventionally holds the generator (events with `targetId === 0` go here); slots 1..N are insert FX taking the previous slot's output as input. Multi-channel routing is Phase 6.
- `PluginRegistry.ts` — Main-thread catalog of installed plugins. `install` / `has` / `get` / `list`, plus `static loadBuiltin(baseUrl)` for the canonical `plugin.json` + `plugin.wasm` + `ui/<entry>` folder layout.
- `WorkletProtocol.ts` — Pure protocol class wrapping a `MessagePort`-shaped object. `loadPlugin(args)` posts `INSTANTIATE_PLUGIN` and awaits the matching `INSTANCE_READY` (carrying both ring SABs). Used by EngineClient; tested with a hand-rolled port stub.
- `PluginUIProtocol.ts` — Iframe ↔ host postMessage envelopes: `HELLO` (host → iframe, carries manifest + initialParams + ring SABs), `READY` (iframe → host on load), `STATE_RESTORE` / `STATE_SNAPSHOT_*` (defined, no Phase 3 consumers). Plus `isReady` / `isStateSnapshot*` validators.
- `PluginUIHost.ts` — Per-instance iframe lifecycle. Builds a Blob URL from the plugin's HTML with a vanilla-JS bootstrap prepended that exposes `window.__noa = { manifest, initialParams, onReady, setParam(idx, value), pollNotify() }`. Plugin HTML never touches the binary ring layout directly. Sandbox is `allow-scripts allow-same-origin` — `allow-same-origin` is required for SAB postMessage across the iframe boundary.
- `bootBuiltins.js` — Boot helper that builds a `PluginRegistry` containing both built-in plugins (manifest + compiled WebAssembly.Module + UI HTML). Vite resolves the JSON / `?url` / `?raw` imports at build time.

Tests live under `src/engine/**/__tests__/*.test.ts` and run via `npm test` (Vitest, Node environment). Anything that touches `AudioContext` or a real iframe is verified by manual browser smoke tests, not unit tests.

### Built-in plugins (`src/builtin-plugins/`)

AssemblyScript-authored WASM plugins. Each plugin folder contains:
- `plugin.json` — manifest
- `<id>.wasm` — committed build artifact (`sine.wasm`, `gain.wasm` — folder-named to avoid Rollup's basename-keyed asset dedup; ZIP-packaged Phase 5 plugins will use the spec's `plugin.wasm` instead)
- `src/index.ts` — AssemblyScript source
- `asconfig.json` — `--runtime stub --bindings raw` for zero GC and no JS wrapper
- `ui/index.html` — optional floating UI: vanilla JS + inline SVG knobs, reads/writes via `window.__noa`

Two plugins ship today:
- **`com.noa.sine`** (kind `gen`) — 8-voice polyphonic sine. Params: Volume (0..1, default 0.5), Octave (-2..+2 integer, default 0).
- **`com.noa.gain`** (kind `fx`) — linear gain insert. Params: Gain (0..4, default 1, displayed in dB).

Rebuild after editing AS source with `./scripts/build-plugins.sh` (also wired up as `npm run build:plugins`). The script also builds two unit-test fixtures (`src/engine/__tests__/fixtures/test-plugin` and `gen-test`) which intentionally keep the spec's `plugin.wasm` filename since they're loaded via `fs.readFile` and never bundled.

### Coordinator module (`src/coordinator/`)

TypeScript module hosting a `SharedWorker` that owns the canonical project state.

- `projectModel.ts` — `Project` shape (tracks, clips, channels, bpm, loop, metronome) + `seedProject()` that materializes the data.js demo as a typed value.
- `actions.ts` — Discriminated-union `Action` type. Every mutation is an action.
- `reducer.ts` — Pure `applyAction(state, action) → [next, patches, inversePatches]` via Immer's `produceWithPatches`. Unknown IDs are no-ops. Calls `enablePatches()` at module load (Immer 10 requires it for patch support).
- `history.ts` — Undo/redo as a stack of patch transactions. Capped at 100 entries. Callers (the worker) must guard against empty-patch transactions; the stack itself does not.
- `protocol.ts` — `ClientToWorker` / `WorkerToClient` message envelopes.
- `persistence.ts` — `OpfsProjectStore` (read/write `project.json` in OPFS) + `DebouncedSaver` (250ms coalescing).
- `coordinator.worker.ts` — `SharedWorker` entry. Owns state, accepts ports, broadcasts patches.
- `ClientBridge.ts` — Main-thread adapter. Mirrors state via `applyPatches`; exposes `dispatch`/`undo`/`redo`/`subscribe`.
- `useProject.js` — React hooks (`useProject(selector)`, `useDispatch()`, `useUndoRedo()`) over `useSyncExternalStore`. Selectors must be stable references — module-scope is the cleanest pattern (e.g. `const selectTracks = (p) => p.tracks;`).
- `connectCoordinator.js` — Singleton bridge; first call creates the `SharedWorker`, subsequent calls return the same bridge.
