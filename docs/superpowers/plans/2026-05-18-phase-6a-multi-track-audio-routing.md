# Phase 6a: Multi-track audio routing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the demo song play. Each track's generator runs through its mixer channel's FX rack and out to master. Every channel publishes a real meter. Phase 4/5 invariants stay intact (built-ins via OPFS, preset hot-swap, per-instance worker).

**Design reference:** `docs/superpowers/specs/2026-05-18-phase-6a-multi-track-audio-routing-design.md`.

**Phase invariants kept:**
- All existing 228 unit tests pass at every commit (after adapting tests to the breaking `EngineEvent.sampleTime` change).
- The single `EngineClient` + single `AudioWorkletNode` shape stays — multi-track routing lives *inside* the worklet.
- Phase 5's SW + OPFS install flow is untouched.

**Out of scope (per the design doc):**
- Track-level FX inserts.
- Multi-destination sends (only `sends[0]` honored).
- Audio clip PCM playback (the Vox track stays silent).
- Engine-driven transport (Phase 6b).
- UI dispatches to coordinator (Phase 6b/c).

---

## File structure

**Create:**
- `src/engine/MixerRouter.ts` — Multi-chain router that owns N `PluginChain`s plus the routing graph.
- `src/engine/__tests__/MixerRouter.test.ts`
- `src/engine/ClipScheduler.ts` — Main-thread look-ahead MIDI scheduler.
- `src/engine/__tests__/ClipScheduler.test.ts`

**Modify:**
- `src/engine/EngineEvent.ts` — `frameOffset: u32` → `sampleTime: u64`. Adjust encode/decode; bump payload offsets.
- `src/engine/__tests__/EngineEvent.test.ts` — same fields.
- `src/engine/audio-worklet.ts` — replace single `PluginChain` with `MixerRouter`; honour `chainId` on `INSTANTIATE_PLUGIN`; handle `UPDATE_ROUTING`; sample-time event dispatch.
- `src/engine/PluginInstance.ts` + `PluginChain.ts` — event drains read `sampleTime` for scheduling; downstream processing converts to per-block `frameOffset`.
- `src/engine/WorkletProtocol.ts` — `LoadPluginArgs.chainId`; new `updateRouting` envelope.
- `src/engine/EngineClient.ts` — surface `updateRouting`, plumb `chainId` through `loadPlugin`, add `pushEventAt(sampleTime, ...)`.
- `src/engine/PluginChain.ts` — drop the assumption that slot 0 is "generator"; chain owns whatever slots are installed.
- `src/App.jsx` — multi-chain boot, routing-sync effect, real channel meters, ClipScheduler integration on play.
- `CLAUDE.md` — Phase 6a module + commands.
- `docs/superpowers/plans/2026-05-17-noa-daw-roadmap.md` — mark Phase 6a shipped.

---

### Task 1: EngineEvent — sampleTime (breaking change)

**Files:** `src/engine/EngineEvent.ts`, `src/engine/__tests__/EngineEvent.test.ts`.

The 32-byte frame replaces `frameOffset: u32` (bytes 4–8) with `sampleTime: u64` (bytes 4–12). Payload offsets for `targetId`, `note`, `velocity`, `channel`, `paramIndex`, `value`, `command`, `positionBeats`, `bpm` shift by +4 bytes. Payload fits since all variants use ≤ 20 bytes.

- [ ] **Step 1:** Update layout constants and encode/decode for every variant.
- [ ] **Step 2:** Update `EngineEvent.test.ts` field names + binary layout assertions.
- [ ] **Step 3:** Update all callers in `src/engine/` to use `sampleTime` instead of `frameOffset`. Most current callers set `frameOffset: 0` (immediate dispatch); they migrate to `sampleTime: 0` with the documented meaning "fire on or before the next process() call".
- [ ] **Step 4:** Confirm all tests pass. Commit: `refactor(engine): EngineEvent.sampleTime replaces frameOffset`

---

### Task 2: MixerRouter — pure router (no worklet integration yet)

**Files:** `src/engine/MixerRouter.ts`, `src/engine/__tests__/MixerRouter.test.ts`.

```ts
interface RoutingConfig {
  tracks: Array<{
    id: string;            // 't1'
    chainId: string;       // 't1' — generator chain
    channelId: string;     // 'm1'
    mute: boolean;
    solo: boolean;
  }>;
  channels: Array<{
    id: string;            // 'm1'
    fxChainId: string;     // 'm1' — FX chain (same name; lives in a separate Map slot)
    vol: number;
    pan: number;
    mute: boolean;
    solo: boolean;
    sendTo: string | null; // 'm0' or 'mB'
  }>;
  channelOrder: string[];  // topo-sorted, master last
}

class MixerRouter {
  constructor(maxBlockSize: number);
  installChain(chainId: string, kind: 'generator' | 'fx'): PluginChain;
  removeChain(chainId: string): void;
  getChain(chainId: string): PluginChain | undefined;
  /** Map an instanceId to its chain so event routing works by instance. */
  registerInstance(instanceId: string, chainId: string): void;
  unregisterInstance(instanceId: string): void;
  queueEvent(instanceId: string, frame: Uint8Array): void;
  updateRouting(cfg: RoutingConfig): void;
  /** Per-channel: peak, rms. Index parallel to last `cfg.channels`. */
  processBlock(blockSize: number, outStereo: Float32Array): ChannelMeter[];
}
```

`processBlock` semantics:
1. Apply solo: if any track has `solo=true`, only soloed tracks are audible; otherwise honour mute.
2. For each audible track with a generator chain, write `[blockSize × 2]` into the track's per-track scratch buffer (zero-init per block).
3. Add each track's scratch into its channel's input mix bus.
4. Iterate channels in `channelOrder`. For each:
   - Run the channel's FX chain in-place on its input bus.
   - Apply vol + pan into a stereo output.
   - If `sendTo` is non-null, add the stereo output into `sendTo`'s input mix bus.
   - Record peak/rms.
5. Master's stereo output is written to `outStereo`.

- [ ] **Step 1:** Author the class + a `StubChain` test helper that fills its output buffer with a deterministic signal (e.g. a constant `value` per chain).
- [ ] **Step 2:** TDD: routing sums tracks → channel correctly, mute zeroes a track, solo isolates, vol/pan apply, sends mix into the destination, master gathers everything, topo order is honoured.
- [ ] **Step 3:** Commit: `feat(engine): MixerRouter — multi-chain routing graph`

---

### Task 3: Worklet integration

**Files:** `src/engine/audio-worklet.ts`.

Replace the single `PluginChain` field with a `MixerRouter`. `INSTANTIATE_PLUGIN` payload now includes `chainId: string` and `chainKind: 'generator' | 'fx'`. `DESTROY_INSTANCE` takes `instanceId` and looks up its chain via `MixerRouter.unregisterInstance`. `UPDATE_ROUTING` posts a fresh `RoutingConfig`.

Event drain logic moves into a small min-heap-style pending-event queue keyed by `sampleTime`. Each block:
1. Pop events from the engine event ring; insert into the heap.
2. While the heap's min ≤ currentSample + blockSize, pop one, compute `frameOffset = sampleTime - currentSample`, route to its chain.
3. Call `router.processBlock(blockSize, outBus)`.
4. Publish per-channel meter frames + master telemetry.

Per-channel meter frame: 16 bytes. Layout: `[channelHash:u32][peak:f32][rms:f32][blockCounter:u32]`. The master keeps `channelHash = 0` for compatibility with existing main-thread reads of `'m0'`.

- [ ] **Step 1:** Replace internal state with the router; wire INSTANTIATE/DESTROY/UPDATE_ROUTING.
- [ ] **Step 2:** Implement the sample-time scheduling heap (bounded, drops oldest on overflow with a warn).
- [ ] **Step 3:** Verify the chain test suite still passes (most won't touch the worklet directly; the build smoke-tests it).
- [ ] **Step 4:** Commit: `feat(engine): audio worklet drives a MixerRouter + scheduled events`

---

### Task 4: WorkletProtocol + EngineClient surface

**Files:** `src/engine/WorkletProtocol.ts`, `src/engine/EngineClient.ts`, `src/engine/__tests__/WorkletProtocol.test.ts`.

- [ ] **Step 1:** `LoadPluginArgs.chainId: string; chainKind: 'generator' | 'fx';`.
- [ ] **Step 2:** Add `updateRouting(config: RoutingConfig)` to both. Posts `UPDATE_ROUTING`.
- [ ] **Step 3:** Add `pushEventAt({ sampleTime, ... })` — fire-and-forget event-ring write.
- [ ] **Step 4:** Update WorkletProtocol tests + EngineClient consumers.
- [ ] **Step 5:** Commit: `feat(engine): WorkletProtocol + EngineClient learn routing & scheduled events`

---

### Task 5: ClipScheduler — pure logic

**Files:** `src/engine/ClipScheduler.ts`, `src/engine/__tests__/ClipScheduler.test.ts`.

```ts
class ClipScheduler {
  constructor(opts: { sampleRate: number; lookaheadSamples: number;
                      pushEvent: (frame: Uint8Array) => void;
                      readCurrentSample: () => number; });
  setProject(p: { tracks: Track[]; clips: Clip[]; bpm: number;
                  loop: boolean; loopEndBeats: number;
                  trackInstanceIds: Map<string, number /* numeric targetId */>; }): void;
  /** Called from a RAF in App.jsx. Advances internal cursor and emits events. */
  tick(now: number): void;
  start(startSample: number, startBeat: number): void;
  stop(): void;
}
```

The targetId numeric mapping: the worklet routes events by `targetId`. With multi-chain we need a stable instanceId → numeric id map; the simplest is to hash the instanceId to a 32-bit value (FNV-1a) and let MixerRouter look up the chain by the hash. App.jsx supplies the map from coordinator state.

- [ ] **Step 1:** TDD with a fake engine. Cases: emits NoteOn at correct sampleTime within lookahead, emits paired NoteOff, mute skips, solo overrides, loop wrap clears pending + reschedules from beat 0, BPM change mid-play recalculates remaining notes.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Commit: `feat(engine): ClipScheduler — main-thread look-ahead MIDI sequencer`

---

### Task 6: App.jsx — multi-chain boot + routing + real meters + scheduler

**Files:** `src/App.jsx`.

This is the biggest UI-side change. Breaks the boot effect into:

1. **Build chains:** for each track with a generator → install a `generator` chain (id = track id); for each channel → install an `fx` chain (id = channel id) regardless of whether it has effects today (so adding FX later doesn't require chain re-creation).
2. **Load plugins:** generators into their track chains (slot 0), channel effects into their channel chains in order.
3. **Build routing config:** topo-sort channels by walking `sends[0]`; emit a `RoutingConfig`.
4. **Send routing:** `engine.updateRouting(config)`.
5. **Re-sync on coordinator changes:** any change to `tracks` / `channels` / mute / solo / `sends` re-emits routing.

Meter RAF: replaces `sin()`/`Math.random()` with `engine.readMeters()` drain, indexed by channelHash → channelId map.

Transport: on play, instantiate a `ClipScheduler`, call `start(currentSamples, currentBeats)`. RAF tick calls `scheduler.tick()`. On stop, `scheduler.stop()`.

- [ ] **Step 1:** Implement multi-chain boot.
- [ ] **Step 2:** Wire routing-sync effect.
- [ ] **Step 3:** Real meters.
- [ ] **Step 4:** ClipScheduler on play.
- [ ] **Step 5:** Manual smoke in the dev server (Play, listen, mute t1, watch m1 drop).
- [ ] **Step 6:** Commit: `feat(app): wire multi-track routing + clip MIDI playback`

---

### Task 7: Cleanup + docs

**Files:** `CLAUDE.md`, `docs/superpowers/plans/2026-05-17-noa-daw-roadmap.md`.

- [ ] **Step 1:** CLAUDE.md update: new `MixerRouter`, `ClipScheduler`, multi-chain semantics.
- [ ] **Step 2:** Roadmap: mark Phase 6a shipped, leave 6b (engine-driven transport) and 6c (UI dispatches + autosave) on the queue.
- [ ] **Step 3:** Run the full verification suite (`npm test && npm run typecheck && npm run build`).
- [ ] **Step 4:** Commit: `docs: Phase 6a shipped — multi-track audio routing`

---

## Self-review checklist

**Spec coverage:**
- Multi-chain worklet → Task 3
- Routing topology → Task 2
- Clip MIDI scheduling → Task 5
- Per-channel meters → Task 3 (worklet pushes) + Task 6 (main reads)
- EngineEvent sampleTime → Task 1
- App.jsx integration → Task 6

**Test coverage:**
- EngineEvent — updated for sampleTime layout.
- MixerRouter — new (Task 2).
- WorkletProtocol — updated for chainId + updateRouting.
- ClipScheduler — new (Task 5).
- App.jsx — manual smoke (Task 6) since it touches AudioContext + UI.

**Risks acknowledged:** topological cycles (validated main-thread), event ring overflow (lookahead size capped, ring at 4096 frames), loop-wrap stuck notes (synthetic NoteOff at loopEnd), Chromium-only render quantum (128 frames hard-coded in scratch buffers).
