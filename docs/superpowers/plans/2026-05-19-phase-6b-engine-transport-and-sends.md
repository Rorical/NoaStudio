# Phase 6b: Engine-driven transport + multi-destination sends — Implementation Plan

**Goal:** Worklet owns transport state (playing, playhead, loop). The main thread reads playhead from a 4×u32 telemetry SAB. Buses (`mB`, `mR`) receive audio via multi-destination sends.

**Design reference:** `docs/superpowers/specs/2026-05-19-phase-6b-engine-transport-and-sends-design.md`.

---

## File structure

**Modify:**
- `src/engine/EngineClient.ts` — telemetry SAB grows; `playheadBeats()`, `setLoop()`; `RoutingConfig.ChannelRouting.sendsTo`.
- `src/engine/WorkletProtocol.ts` — new `SET_LOOP` envelope.
- `src/engine/MixerRouter.ts` — `sendsTo: string[]` + `sendsLevels: number[]`; multi-destination accumulation; topo sort sums across all destinations.
- `src/engine/__tests__/MixerRouter.test.ts` — new fan-out cases; topo sort with fan-out.
- `src/engine/audio-worklet.ts` — TransportState; drain Transport / Tempo / Loop control events; publish 4×u32 telemetry; sample-accurate loop wrap.
- `src/App.jsx` — `buildRoutingConfig` fans out `sends`; transport RAF reads `engine.playheadBeats()`; routing-sync effect includes loop region; ClipScheduler reset detection.

---

### Task 1: Multi-destination sends in MixerRouter

- [ ] Change `ChannelRouting.sendTo: string | null` to `sendsTo: string[]; sendsLevels: number[]`.
- [ ] Update `processBlock` to fan out into each destination scaled by its level.
- [ ] Update `topoSortChannels` (it's in App.jsx, not router) to count in-edges from every destination.
- [ ] Extend `MixerRouter.test.ts` with: single-source → two-destination, full-level fan-out math, default level = 1.0.
- [ ] Commit: `feat(engine): MixerRouter — multi-destination sends`

### Task 2: Telemetry SAB grows + playheadBeats

- [ ] In `EngineClient.init`, allocate `new SharedArrayBuffer(16)` (4 u32 words) instead of 4.
- [ ] Add `playheadBeats(): number` to EngineClient.
- [ ] Worklet stores playhead beats in `telemetry[1]` (f32 reinterpret via `setFloat32`/`getFloat32` over the same DataView).
- [ ] Worklet stores `playing` flag in `telemetry[2]`.
- [ ] Worklet stores `blockCounter` in `telemetry[3]`.
- [ ] Commit: `feat(engine): grow telemetry SAB to 4 u32 + playheadBeats accessor`

### Task 3: Worklet transport state

- [ ] Add a `TransportState` field to `NoaEngineProcessor`.
- [ ] In the event-drain step, recognise `EVT_TRANSPORT` and `EVT_TEMPO` and apply to TransportState (don't pass them to `router.queueEvent`).
- [ ] Add `SET_LOOP` message handler.
- [ ] In `process`, if `playing`, advance `playheadSamples += blockSize`; if `loopEnabled && playheadSamples >= loopEndSamples`, wrap.
- [ ] After processing, publish telemetry.
- [ ] Commit: `feat(engine): worklet owns transport state + sample-accurate loop wrap`

### Task 4: EngineClient.setLoop + App.jsx routing-sync

- [ ] Add `EngineClient.setLoop({enabled, startBeats, endBeats})` posting `SET_LOOP`.
- [ ] App.jsx: post `engine.setLoop(...)` when `loop`/`bpm` changes.
- [ ] App.jsx `buildRoutingConfig`: fan out `channel.sends` into `sendsTo` + `sendsLevels` (default 1.0 per destination).
- [ ] App.jsx `topoSortChannels`: iterate every destination per channel for in-degree calc.
- [ ] Commit: `feat(app): setLoop + multi-destination routing config`

### Task 5: App.jsx transport RAF reads playhead from engine

- [ ] Transport RAF: read `time` from `engine.playheadBeats()` directly. Drop the sample-delta math.
- [ ] On Play: still post `engine.play(time)`.
- [ ] On Stop: post `engine.stop()`, reset local time to 0.
- [ ] Loop wrap detection: when playheadBeats drops below the previous tick's, fire `scheduler.reset({startSample, startBeat})` with the new anchor.
- [ ] Commit: `feat(app): transport RAF reads playhead from engine telemetry`

### Task 6: Smoke + docs

- [ ] Playwright smoke: drum bus + reverb bus meters > 0 during play; play head advances through the loop wrap; BPM changes mid-play don't crash.
- [ ] CLAUDE.md update.
- [ ] Mark Phase 6b shipped in roadmap.
- [ ] Commit: `docs: Phase 6b shipped — engine-driven transport + multi-destination sends`

---

## Self-review checklist

**Spec coverage:** transport state moves to worklet → Task 3. Telemetry grows + playheadBeats → Task 2. Loop region as a message → Task 3+4. Multi-destination sends → Task 1+4. App.jsx integration → Task 5. Smoke → Task 6.

**Test coverage:** Multi-destination sends covered by Vitest. Worklet transport state covered by Playwright (no Vitest precedent for worklet code).

**Risks acknowledged:** Telemetry tearing (per-field Atomics is fine for a UI RAF). Loop region in samples vs bpm changes (re-send SET_LOOP on bpm change). f32 beats precision (acceptable for v1).
