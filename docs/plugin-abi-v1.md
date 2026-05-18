# Noa Plugin ABI v1

Authoritative reference. Last updated: 2026-05-18. ABI version: **1**.

This document is everything a plugin author needs to write a conforming Noa plugin. The host-side design rationale lives in `docs/superpowers/specs/2026-05-18-phase-3-plugin-abi-v1-design.md`.

A Noa plugin is a **WebAssembly module** with a documented set of exports, plus a JSON **manifest** that describes the plugin to the host. Plugins can ship a small **HTML UI** that opens as a floating window inside Noa.

---

## 1. Required exports (plugin → host)

| Symbol | Signature | Required for | Purpose |
| --- | --- | --- | --- |
| `noa_abi_version` | `() -> u32` | all | Returns `1`. Mismatch with host's expected version = refuse to load. |
| `noa_init` | `(sample_rate: u32, max_block_size: u32) -> u32` | all | Allocate buffers, prepare state. Returns `1` on success, `0` on failure. Called once per instance, before any other entry point. |
| `noa_get_audio_in_ptr` | `() -> u32` | `fx` | Stable pointer to interleaved-stereo `f32` input buffer of length `max_block_size * 2`. |
| `noa_get_audio_out_ptr` | `() -> u32` | all | Stable pointer to interleaved-stereo `f32` output buffer of length `max_block_size * 2`. |
| `noa_get_event_buf_ptr` | `() -> u32` | all | Pointer to events buffer (packed 32-byte `EngineEvent` frames). |
| `noa_event_buf_capacity` | `() -> u32` | all | Number of event frames the buffer holds. Host caps writes to this number. |
| `noa_get_param_buf_ptr` | `() -> u32` | all | Pointer to `f32[noa_param_count()]`. Host writes canonical param values here before each `noa_process`. |
| `noa_param_count` | `() -> u32` | all | Declared parameter count. Must equal `manifest.params.length`. |
| `noa_process` | `(n_frames: u32, n_events: u32) -> void` | all | Read events + params + audio in; write audio out. Must be RT-safe (no allocations, no syscalls). |
| `noa_state_size` | `() -> u32` | all | Bytes required for a full preset snapshot. Returns `0` if plugin is stateless. |
| `noa_get_state` | `(out_ptr: u32) -> u32` | if `state_size > 0` | Write state bytes to `out_ptr` (within plugin memory). Returns bytes actually written. |
| `noa_set_state` | `(in_ptr: u32, n_bytes: u32) -> u32` | if `state_size > 0` | Restore from bytes. Returns `1` on success, `0` on failure. |
| `noa_destroy` | `() -> void` | all | Final cleanup before instance is dropped. |
| `memory` | `WebAssembly.Memory` | all | Standard linear-memory export. All toolchains emit this by default. |

The host calls the `noa_get_*_ptr` exports **once after `noa_init`** and caches the results. Plugins must not relocate their internal buffers after `noa_init` returns.

---

## 2. Host imports (host → plugin)

Plugins import a single namespace, `host`:

| Symbol | Signature | Purpose |
| --- | --- | --- |
| `host.log` | `(ptr: u32, len: u32) -> void` | Log a UTF-8 string from plugin memory. Host writes to console with a `[plugin:<id>]` prefix. |
| `host.random` | `() -> f64` | Returns `Math.random()`. |
| `host.get_tempo` | `() -> f32` | Returns the engine's current BPM. |

Imports that the plugin doesn't reference can be omitted from its module's imports section. The host always provides all three.

---

## 3. Memory model

The plugin owns its linear memory. The host's interaction is strictly:

1. After `noa_init`, **once per instance:** read all `noa_get_*_ptr` and `noa_event_buf_capacity` exports. Cache the pointers and the capacity.
2. **Each audio block, in this order:**
   - Write the current canonical parameter array as `f32[noa_param_count()]` into the param buffer at `paramBufPtr`.
   - Write up to `noa_event_buf_capacity()` packed 32-byte event frames into the event buffer at `eventBufPtr`. Capture the count as `n_events`.
   - For `fx` plugins: write the upstream slot's output samples (interleaved stereo, `n_frames * 2` floats) into the input buffer at `audioInPtr`.
   - Call `noa_process(n_frames, n_events)`.
   - Read `n_frames * 2` samples from the output buffer at `audioOutPtr`.
3. **Never write** anywhere else in the plugin's memory.

Generator plugins (`kind: "gen"`) ignore `audioInPtr`; the host doesn't write input for them.

---

## 4. Event frame layout

Same format as Noa's internal `EngineEvent` (32 bytes per frame, little-endian):

| Bytes | Field | Notes |
| --- | --- | --- |
| 0 | `type: u8` | `1` = NoteOn, `2` = NoteOff, `3` = ParamSet, `4` = Transport, `5` = Tempo |
| 1 | `flags: u8` | reserved, 0 |
| 2..4 | reserved | 0 |
| 4..8 | `frame_offset: u32` | sample-accurate offset within this block (`< n_frames`) |
| 8..32 | payload | type-specific (see below) |

Per-type payload (bytes 8..32):

- **NoteOn:** `target_id u32 @8`, `note u8 @12`, `velocity u8 @13`, `channel u8 @14`
- **NoteOff:** `target_id u32 @8`, `note u8 @12`, `channel u8 @13`
- **ParamSet:** `target_id u32 @8`, `param_index u32 @12`, `value f32 @16`
- **Transport:** `command u8 @8` (0=stop, 1=play, 2=pause), `position_beats f64 @16`
- **Tempo:** `bpm f32 @8`

For plugin authors: `target_id` is the plugin instance id and is filtered by the host before events reach you. Treat all incoming events as addressed to your instance.

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

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | Reverse-DNS unique identifier; registry key. |
| `name` | string | yes | Display name. |
| `version` | string | yes | Semver; informational in v1. |
| `abi_version` | number | yes | Must equal `1`. |
| `kind` | `"gen"` \| `"fx"` | yes | Generator (no audio input) or effect (audio input). |
| `params` | `ParamDecl[]` | yes (may be empty) | Order matches param buffer indices. |
| `ui` | `{entry, width, height}` | no | Path within the plugin's `ui/` folder. If absent, host renders an auto-UI from `params`. |

`ParamDecl`:

```typescript
{
  name: string;            // display label
  min: number;             // lower bound
  max: number;             // upper bound; must be > min
  default: number;         // initial value; must be in [min, max]
  step?: number;           // 0 / undefined = continuous; >0 = quantized
  unit?: string;           // displayed alongside value
  display?: "linear" | "log" | "db" | "hz" | "percent";  // UI hint, default "linear"
}
```

---

## 6. Threading and timing

- `noa_process` runs **synchronously inside the AudioWorklet**. No allocations, no `memory.grow`, no recursion into JS. Plugins must preallocate everything in `noa_init`.
- `noa_init`, `noa_destroy`, `noa_get_state`, and `noa_set_state` run from a host-controlled context that pauses audio processing for the duration. Brief glitches are possible — keep these calls fast.
- Plugin authors are responsible for **voice allocation**. The host does not manage voices; it forwards raw NoteOn/NoteOff events.

---

## 7. Worked example: minimum-viable gain plugin (AssemblyScript)

```typescript
// src/index.ts — compiles to a Noa plugin in ~1 KB of WASM.

const MAX_BLOCK = 2048;
const MAX_EVENTS = 256;
const PARAM_COUNT = 1;

const audioIn = new StaticArray<f32>(MAX_BLOCK * 2);
const audioOut = new StaticArray<f32>(MAX_BLOCK * 2);
const eventBuf = new StaticArray<u8>(MAX_EVENTS * 32);
const paramBuf = new StaticArray<f32>(PARAM_COUNT);

export function noa_abi_version(): u32 { return 1; }

export function noa_init(sampleRate: u32, maxBlockSize: u32): u32 {
  if (maxBlockSize > MAX_BLOCK) return 0;
  paramBuf[0] = 1.0;
  return 1;
}

export function noa_get_audio_in_ptr():   u32 { return changetype<usize>(audioIn) as u32; }
export function noa_get_audio_out_ptr():  u32 { return changetype<usize>(audioOut) as u32; }
export function noa_get_event_buf_ptr():  u32 { return changetype<usize>(eventBuf) as u32; }
export function noa_event_buf_capacity(): u32 { return MAX_EVENTS; }
export function noa_get_param_buf_ptr():  u32 { return changetype<usize>(paramBuf) as u32; }
export function noa_param_count():        u32 { return PARAM_COUNT; }

export function noa_process(nFrames: u32, nEvents: u32): void {
  const gain: f32 = paramBuf[0];
  for (let i: u32 = 0; i < nFrames * 2; i++) {
    audioOut[i] = audioIn[i] * gain;
  }
}

export function noa_state_size(): u32 { return 4; }
export function noa_get_state(outPtr: u32): u32 { store<f32>(outPtr, paramBuf[0]); return 4; }
export function noa_set_state(inPtr: u32, nBytes: u32): u32 {
  if (nBytes != 4) return 0;
  paramBuf[0] = load<f32>(inPtr);
  return 1;
}

export function noa_destroy(): void {}
```

Build:

```bash
npm install --save-dev assemblyscript
npx asc src/index.ts -o plugin.wasm --runtime stub --optimize
```

Pair with a manifest:

```json
{
  "id": "com.example.gain",
  "name": "Gain",
  "version": "1.0.0",
  "abi_version": 1,
  "kind": "fx",
  "params": [
    { "name": "Gain", "min": 0, "max": 4, "default": 1, "display": "db", "unit": "x" }
  ]
}
```

— and you have a complete Noa plugin.

---

## 8. Compliance checklist

Before shipping:

- [ ] `noa_abi_version()` returns `1`.
- [ ] `noa_param_count()` matches `manifest.params.length`.
- [ ] All required exports are present (Section 1).
- [ ] `noa_process` allocates no memory and makes no JS calls beyond declared host imports.
- [ ] `noa_init` succeeds (returns `1`) for `(sample_rate=48000, max_block_size=2048)`.
- [ ] State round-trips: `noa_set_state(noa_get_state(x))` restores plugin to the same observable state.
- [ ] If the plugin ships a UI, `manifest.ui.entry` exists in the plugin's `ui/` folder.
