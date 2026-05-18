# Phase 6a: Multi-track audio routing — Design Spec

**Status:** Design draft. Plan: TBD on approval.

**Predecessors:** Phase 5 (Service Worker delivery) shipped. Built-in plugins serve from OPFS; new plugins install from URL; the engine still runs a single `PluginChain` in the worklet with no clip MIDI playback.

**This phase makes the demo song actually play.** Each of the 8 tracks runs its assigned generator into its mixer channel's FX rack and onward through the bus graph to master. MIDI notes scheduled on clips fire sample-accurately through the engine event ring. Every channel publishes a real peak/RMS meter — the `sin()`/`random()` simulations in `App.jsx` are deleted.

---

## 1. End-of-phase demo

1. Open the bundled demo project. Hit Play.
2. The kick track (t1) drives `com.noa.sine` into channel m1, the snare/hats/bass/etc. likewise. The master channel sums it all through `com.noa.gain` and the speakers play the demo song.
3. All eight mixer channel meters reflect real audio (the kick channel pumps on every downbeat; the pad channel reads continuously; idle channels stay at −∞).
4. Mute t1 from the playlist — the kick goes silent and channel m1's meter drops.
5. Move a clip in the playlist — the new position takes effect on the next playback wrap (clip edits are committed live but scheduled per-loop for simplicity).

Audio quality target: glitch-free playback at 124 BPM for at least a full minute, with the AudioContext's render quantum at 128 frames (Chromium default).

---

## 2. Out of scope (deferred)

- **Track-level FX racks.** Phase 6a runs the generator straight into the channel; per-track inserts come later.
- **Multi-destination sends.** v1 honors only the *first* entry in `channel.sends`; multi-send mixing (e.g. send-to-master + send-to-reverb-bus simultaneously) is a follow-up.
- **Audio clips on disk.** The Vox track (t8) is `type: 'audio'` in the demo; it stays silent in Phase 6a since real PCM playback needs a sampler plugin (Phase 6c+).
- **Sample-accurate clip *edits* mid-play.** Edits land between blocks; we don't reschedule pending NoteOn/NoteOff frames if a clip moves in the middle of a bar.
- **Per-track sends, pre/post-fader sends.** Single post-fader send only.
- **MIDI input / external clock.** Internal sequencer + engine clock only.
- **Voice stealing across tracks.** Each generator gets the full MIDI stream for its track; voice management is the plugin's problem.

---

## 3. Architecture

```
Main thread                     AudioWorklet                              Audio out
───────────                     ──────────────                            ─────────
ClipScheduler ──events──▶ event ring ──▶  MixerRouter
  (RAF, look-ahead 50ms)                    │
                                            ├─ chain[t1]   ─── audio bus[1] ─┐
                                            ├─ chain[t2]   ─── audio bus[2] ─┤
                                            ├─ chain[t3]   ─── audio bus[3] ─┼─▶ channel mixer  ───▶  master mix  ──▶ stereo out
                                            ├─  ...                          │     m1..m8 + sends
                                            ├─ chain[m1]   (FX rack)         │
                                            ├─ chain[m2]   (FX rack)         │
                                            ├─  ...                          │
                                            └─ chain[m0]   (master FX)       ─┘

Telemetry                        meter ring  ──▶ MeterView → main thread RAF → channel-strip UI
```

### 3.1 Chain identity

Each plugin instance now lives in a named chain:

- Track generator → chain id `'t' + trackId.slice(1)` (e.g. `t1`).
- Channel FX → chain id matches the channel id (`m0`..`mR`).

The worklet keeps a `Map<string, PluginChain>` keyed by chain id. Each chain runs its own slot ladder; inside a chain, slots are still linear (slot 0 → slot 1 → …).

Old `INSTANTIATE_PLUGIN { slot: number }` becomes `INSTANTIATE_PLUGIN { chainId: string, slot: number }`. **Clean break** — no compat shim for the prior single-chain protocol.

### 3.2 Routing graph

The `MixerRouter` owns a routing config: a list of `Track { id, chainId, channelId, mute }` plus `Channel { id, fxChainId, vol, pan, mute, solo, send }`. The main thread keeps it in sync via a single `UPDATE_ROUTING` message on every coordinator state change that affects audio topology (tracks list, channels list, mute/solo).

Each block, `MixerRouter.processBlock(blockSize)` runs:

1. **Drain events** by targetId — events route to the chain whose instance owns the matching `instanceId`. (Per-block buffer, not the whole event stream.)
2. **Apply mute/solo** by tagging tracks as silent or audible.
3. **For each track in audible set:**
   - Process its generator chain into a per-track stereo scratch buffer.
   - Add the scratch buffer into its target channel's input mix bus.
4. **Process channels in topological order** (master always last):
   - Run the channel's FX chain on its input bus (in-place).
   - Apply per-channel vol + pan into a stereo bus.
   - Add into each channel listed in `send` (the destination's input mix bus).
   - Compute meter peak/RMS and push to the meter ring.
5. **Master's mixed bus is the worklet output.**

Buffer allocation: pre-allocated `Float32Array(blockSize * 2)` per chain + per channel input bus, sized at the maximum render quantum (128). No per-block GC.

### 3.3 Topological sort

Channels form a DAG: each channel's `send[0]` points at a downstream channel (eventually master). We compute a topo order once per `UPDATE_ROUTING` and cache it. Cycles fail loud at the main-thread sender (the router accepts the order it's given; cycle detection happens before sending).

For Phase 6a, the demo's topology is:
- `m1..m4` → `m0`
- `m2..m3` → `mB` (drum bus, then `mB → m0`)
- `m5..m8` → `m0`
- `m5..m7` → `mR` (reverb bus, then `mR → m0`)

The demo data has multi-element `sends`. **v1 honors only `sends[0]`.** A subsequent phase adds parallel sends.

### 3.4 Clip MIDI scheduling

The main thread runs a **ClipScheduler** on a 60 Hz loop (separate from the meter RAF). Each tick:

1. Reads the current sample position from telemetry.
2. Looks ahead `LOOKAHEAD_SAMPLES` (≈ 50 ms at 48 kHz = 2400 samples).
3. For each track, finds clips whose `[start, start+length)` overlaps `[currentBeat, currentBeat + lookaheadBeats)`.
4. Inflates the clip's note tuples to absolute sample-time NoteOn/NoteOff pairs.
5. Pushes them onto the engine event ring **sorted by sampleTime**.

The event model gains a new field — events now carry an **absolute sample-time** instead of `frameOffset`. The worklet maintains a *pending event queue* (sorted heap, fixed-capacity) and, each block, dispatches events whose `sampleTime` falls within `[currentSample, currentSample + blockSize)`, deriving `frameOffset = sampleTime - currentSample` at dispatch time.

This is a **breaking change** to the event encoding: a 64-bit `sampleTime` replaces `frameOffset` in the binary frame layout. Every encoder/decoder + every consumer updates in one commit.

Loop wrap: when the loop region wraps from beat 32 to beat 0, the scheduler clears any not-yet-dispatched events and re-scans clips starting at beat 0. NoteOff events with sampleTime inside the wrapped region still fire; ones past the wrap are dropped (the next loop iteration re-schedules its own).

### 3.5 Real meters

`MixerRouter` publishes a meter frame per channel per block. The meter frame layout stays 16 bytes:

```
[0..4]   channelHash (FNV-1a of the channel id string, low 32 bits)
[4..8]   peak (float32)
[8..12]  rms (float32)
[12..16] blockCounter (uint32)
```

Main thread maintains a `Map<channelId, hash>` so the RAF can look up channels by hash without serializing strings into every frame. The `App.jsx` meter RAF replaces its `sin()`/`Math.random()` block with a drain-then-fold:

```js
const latest = new Map();
for (const f of engine.readMeters()) {
  const ch = hashToId.get(f.channelHash);
  if (!ch) continue;
  const prev = latest.get(ch);
  if (!prev || f.peak > prev.peak) latest.set(ch, f);
}
setLevels(Object.fromEntries(latest.entries().map(([id, f]) => [id, f.peak])));
```

---

## 4. Engine surface changes

### 4.1 `EngineEvent` (breaking)

```ts
// 32-byte frame layout, v6 — absolute sample time replaces frameOffset.
interface NoteOnEvent  { type, sampleTime: number /* uint64 */, targetId, note, velocity, channel }
interface NoteOffEvent { type, sampleTime, targetId, note, channel }
// ... ParamSet/Transport/Tempo all gain sampleTime; frameOffset is gone.
```

Encoder/decoder updated. Bumps `EVENT_FRAME_SIZE` only if necessary (uint64 cost is 4 extra bytes — current 32-byte frames already have room since `frameOffset` was only 4 bytes; we steal those 4 bytes and grow the field to 8 by relocating other payload bytes).

Wire-level migration: none — Phase 5 ships; nothing on disk persists EngineEvents.

### 4.2 `PluginChain` — unchanged

`PluginChain` already supports a linear ladder of slots. The new `MixerRouter` owns N of them. No API changes needed.

### 4.3 `MixerRouter` (new)

```ts
class MixerRouter {
  constructor(maxBlock: number);

  /** Install/replace the chain for a given id. */
  installChain(chainId: string): PluginChain;
  /** Remove a chain and its instances. */
  removeChain(chainId: string): void;
  getChain(chainId: string): PluginChain | undefined;

  /** Pump events on a given instance, finding its chain by instance lookup. */
  queueEventByInstance(instanceId: string, frame: Uint8Array): void;

  /** Update routing topology (tracks → channels, send graph, mute/solo). */
  updateRouting(config: RoutingConfig): void;

  /**
   * Process one block. Writes the master mix into outStereo (interleaved L,R),
   * publishes one meter frame per channel to meterRing.
   */
  processBlock(blockSize: number, outStereo: Float32Array,
               meterPush: (frame: Uint8Array) => void): void;
}

interface RoutingConfig {
  tracks: Array<{ id: string; chainId: string; channelId: string; mute: boolean; solo: boolean }>;
  channels: Array<{ id: string; fxChainId: string; vol: number; pan: number;
                    mute: boolean; solo: boolean; sendTo: string | null }>;
  /** Topo-sorted, master last. */
  channelOrder: string[];
}
```

### 4.4 Worklet protocol (breaking)

New messages:

- `INSTANTIATE_PLUGIN { chainId, slot, ... }` — was `{ slot, ... }`.
- `UPDATE_ROUTING { config: RoutingConfig }` — main → worklet.
- `SCHEDULE_EVENT { frame }` — was the un-named "push into event ring" path. Frames carry sample-absolute timestamps.

`PluginChain.queueEventFrame(slot, ...)` is now an internal call. The router's event drain looks up the chain by `targetId` (via an `instanceId → chainId` map maintained alongside chain installs).

### 4.5 EngineClient surface

Add:

- `engine.updateRouting(config)` — main-thread bookkeeping + posts `UPDATE_ROUTING`.
- `engine.startTransport({ bpm, loopStart, loopEnd })` and `engine.stopTransport()` — wraps the existing transport state into something the ClipScheduler can consume.

`loadPlugin` gains `chainId`:

```ts
engine.loadPlugin({ instanceId, chainId: 't1' | 'm0', slot: 0, wasm, manifest, initialParams });
```

### 4.6 ClipScheduler (new)

```ts
class ClipScheduler {
  constructor(engine: EngineClient, opts: { lookaheadMs: number; sampleRate: number });
  /** Project state needed for scheduling. */
  setProject(p: { tracks: Track[]; clips: Clip[]; bpm: number; loop: boolean; loopStartBeats: number; loopEndBeats: number }): void;
  start(): void;
  stop(): void;
  /** Called by the RAF; pulls samples-played from telemetry, emits events. */
  tick(): void;
}
```

Lives in `src/engine/`. Pure logic — no DOM. Tested in Node with a fake engine + fake clock.

---

## 5. Coordinator changes

None to the project model. Phase 6a is engine-only — the coordinator's `tracks`/`channels`/`clips` shape already has everything the router needs. App.jsx is the bridge.

App.jsx changes:
- Boot effect now creates **N+M chains** (one per track with a generator, one per channel with FX or pan/vol) instead of a single chain.
- A new `useEffect` posts `UPDATE_ROUTING` whenever `tracks`/`channels` change.
- The meter RAF stops simulating and reads channel meters from the engine.
- The transport RAF kicks off `ClipScheduler.start()` on play.

The two-RAF model survives for now — Phase 6b (engine-driven transport) replaces it with a single source of truth.

---

## 6. Testing

### 6.1 Vitest (Node)

- **`MixerRouter.test.ts`** — Stub `PluginChain`s that write a known signal. Verify routing sums, send wiring, mute/solo, topo order. Use a 1-sample block to make math hand-verifiable.
- **`ClipScheduler.test.ts`** — Fake engine that captures pushed events. Verify lookahead, loop wrap, mute skip, beat→sample conversion.
- **`EngineEvent.test.ts`** — Existing tests update for the sampleTime field.
- **Reducer / coordinator tests** — Unchanged.

Target: 240+ tests at end of phase (12 router + ~10 scheduler + adjustments).

### 6.2 Manual smoke

- Play the demo, listen for the song.
- Mute t1, watch m1 meter drop.
- Change BPM to 200, confirm tempo follows.
- Stop / play repeatedly — no stuck notes (loop wrap clears pending).

---

## 7. Risks + open questions

- **Render-quantum lock-in.** Chromium hardcodes 128-frame blocks. If we one day target Firefox (which still does 128) or Safari (which negotiates), the per-channel buffers need a resize path. Out of scope for v1.
- **Event ring capacity.** Lookahead × max polyphony × 32 bytes per frame fits comfortably in a 64 KB ring (2048 frames). Quick math: 8 tracks × 16 voices × 50 ms / 5 ms note interval ≈ 1300 events — under capacity, but no slack. We'll size at 128 KB (4096 frames) to be safe.
- **Loop wrap timing.** Notes that started right before the loop point need a NoteOff at the wrap boundary; otherwise they ring forever. The scheduler emits a synthetic NoteOff at `loopEndSampleTime` for any active note. (Plugins that respond to `noa_reset_voices` could replace this; v1 doesn't.)
- **Topological cycles.** A misconfigured `send` chain (m0 → mB → m0) would never terminate the topo sort. Main thread validates and rejects before sending.
- **Per-channel meter cost.** 10 channels × 1 frame each × 750 blocks/sec = 7500 frame writes/sec — negligible. RAF on the main thread reads ≤ 60 Hz, so a 100-frame meter ring is plenty.

---

## 8. Decisions explicitly rejected

- **Per-track effect inserts in v1.** The demo doesn't need them; adds shape complexity. Defer.
- **Web Audio native routing (separate AudioWorkletNodes per track).** Tested briefly conceptually: gives us free Web Audio nodes (gain, pan) but multiplies the WASM-bytes-to-worklet handshake N times and breaks the single-event-ring model. Single worklet with internal routing keeps the wire protocol simple.
- **Pushing the entire MIDI pattern into the worklet (option 2 from the design discussion).** Higher accuracy but doubles the project-state surface area. Lookahead scheduling from the main thread is fine for 50 ms latency.
- **Per-instance meters.** Plugin-level meters (e.g. a compressor's gain reduction display) deserve their own SAB ring in a future phase. Channel meters are what the UI shows today.
