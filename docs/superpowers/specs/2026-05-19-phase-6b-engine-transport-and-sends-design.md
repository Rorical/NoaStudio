# Phase 6b: Engine-driven transport + multi-destination sends — Design Spec

**Status:** Design draft. Plan: TBD on approval.

**Predecessors:** Phase 6a (multi-track audio routing) shipped. Worklet runs a `MixerRouter` per render quantum; main-thread `ClipScheduler` look-aheads MIDI events; channels publish real peak/RMS meters. Transport still lives on the main thread (a `requestAnimationFrame` loop computes the playhead from a sample-delta baseline), and the router only honours `channel.sends[0]` so the demo's drum/reverb buses never receive audio.

**This phase makes the worklet authoritative for transport, and routes every send in the demo data.** The main thread becomes a thin reader of an engine-published `[samples, bpm, beats]` telemetry block; loop boundaries wrap sample-accurately inside the worklet; and channels with multiple destinations (e.g. `['m0','mB']`) split their post-FX output into each one.

---

## 1. End-of-phase demo

1. Open the demo. Hit Play.
2. The drum bus (`mB`) meter pumps with the kick + snare + hats — `m2`/`m3`/`m4`'s `sends[1] === 'mB'` is now respected.
3. The reverb bus (`mR`) meter pumps with the pad + lead + arp + vox.
4. Tweak BPM mid-playback. The worklet sees the new tempo; the playhead keeps ticking; clip notes already in the scheduler's queue keep firing at their absolute sample-time (musically a bit jagged across a tempo change but not glitched).
5. Loop wraps at beat 32. The wrap happens *inside the worklet* on the sample boundary, not at the next RAF tick. Notes near the boundary don't overshoot.
6. Stop. Hit Play again. Position resumes from `time = 0`.

---

## 2. Out of scope (deferred)

- **Track-level FX inserts.** Still deferred to a later phase.
- **Audio clip PCM playback.** The Vox track (`t8`) stays silent; needs a sampler plugin.
- **Pre-fader sends, send levels.** v1 sends carry the post-fader stereo bus at full level into every destination.
- **Engine-driven `time` state without a RAF.** App.jsx still reads telemetry inside a RAF — it just stops doing sample-delta math. Replacing the RAF entirely (e.g. with a `requestVideoFrameCallback`-style channel) is out of scope.
- **Tempo automation.** A single global BPM, set per-block by the worklet.
- **Sample-accurate UI mute/solo/vol updates.** Mute changes during a block still take effect on the next block boundary.

---

## 3. Architecture

### 3.1 Transport state lives in the worklet

```
Worklet                                                 Main thread
─────────                                               ───────────
TransportState {                              telemetry SAB (now 4×u32):
  playing: bool                               [0] playheadSamples (u32, low-wrap)
  playheadSamples: u32                        [1] playheadBeatsFloat32 (f32 reinterpret)
  bpm: f32                                    [2] flags (bit0 = playing)
  loopEnabled: bool                           [3] blockCounter
  loopStartSamples: u32
  loopEndSamples: u32
}
```

The existing `telemetrySab` grows from 1 u32 to 4 u32 (16 bytes). The main thread reads atomically per RAF tick.

Transition rules per render quantum, before `MixerRouter.processBlock`:

1. Drain control events (the existing event ring) for `Transport`/`Tempo`/`Loop`.
2. If `playing`, advance `playheadSamples += blockSize`.
3. If `loopEnabled && playheadSamples >= loopEndSamples`, wrap:
   `playheadSamples = loopStartSamples + (playheadSamples - loopEndSamples)`.
4. Publish the updated state into the telemetry SAB.

### 3.2 Two new control messages (or events)

The Phase 4-shipped `EVT_TRANSPORT` already carries `command + positionBeats`. We keep using it for play/stop/pause. The loop region is a separate, lower-frequency setting — a new `WorkletInbound` message:

```ts
interface SetLoopMessage {
  type: 'SET_LOOP';
  enabled: boolean;
  startBeats: number;
  endBeats: number;
  bpm: number;        // duplicated so worklet can resolve sample positions
  sampleRate: number; // duplicated for the same reason
}
```

(Yes, BPM also flows via `EVT_TEMPO` for sample-accurate timing inside the block. `SET_LOOP` includes a snapshot purely so the worklet can compute `loopStartSamples`/`loopEndSamples` once on receipt.)

### 3.3 Multi-destination sends

`ChannelRouting.sendTo: string | null` becomes `sendsTo: string[]`. v1 carries one numeric send level per destination via `sendsLevels: number[]` of equal length; the default is `1.0` for every destination (full level, matching the existing demo expectation).

The `processBlock` send step changes from:

```ts
if (channel.sendTo) {
  const dest = getInputBus(channel.sendTo);
  for (let i = 0; i < N; i++) dest[i] += fxOut[i];
}
```

to:

```ts
for (let s = 0; s < channel.sendsTo.length; s++) {
  const destId = channel.sendsTo[s];
  const lvl = channel.sendsLevels[s] ?? 1;
  const dest = getInputBus(destId);
  for (let i = 0; i < N; i++) dest[i] += fxOut[i] * lvl;
}
```

`topoSortChannels` continues to walk the graph — but now each channel can contribute to multiple downstream channels. Kahn's algorithm needs to count incoming edges from ALL `sendsTo`, not just one.

### 3.4 Main-thread changes

- `EngineClient`:
  - Reads four telemetry u32s instead of one.
  - New `playheadBeats()` returns the worklet's published beat position.
  - New `setLoop({enabled, startBeats, endBeats})` — posts `SET_LOOP`.
  - `play(beats)` / `stop()` retained; they post `EVT_TRANSPORT` as before.
- `RoutingConfig`: `ChannelRouting.sendTo: string | null` → `sendsTo: string[]` + `sendsLevels: number[]`.
- `App.jsx`:
  - Transport RAF drops the sample-delta math; reads `engine.playheadBeats()` per tick.
  - Loop wrap detection: when `playheadBeats < lastBeatRef`, call `scheduler.reset(...)`. The wrap itself happens in the worklet; the main thread just notices.
  - On Play/Stop button: post `engine.play(time)` / `engine.stop()` — already wired today.
  - `buildRoutingConfig` walks every entry of `channel.sends`, fanning out `sendsTo`/`sendsLevels` accordingly.

### 3.5 Backward-compat

Per the project rule, **none**. `ChannelRouting.sendTo` becomes `sendsTo` in a single commit; every consumer flips at once. The telemetry SAB grows in a single commit too — fixed-size buffers are byte-compatible only when the layout matches, so there's no half-loaded state to worry about.

---

## 4. Testing

### 4.1 Vitest (Node)

- **`MixerRouter.test.ts`** — extend with cases for fan-out sends: one source → two destinations, each receives the full signal scaled by per-destination level; a channel feeding both master and a bus accumulates correctly; topo sort handles fan-out without cycles.
- **`EngineClient.test.ts` (new or extended)** — extracting the playhead-reading helper is tricky because EngineClient touches `AudioContext`. Skip — the helper is a one-liner and is verified by the smoke test.
- **No new worklet tests** — same precedent as Phase 6a (worklet code is integration-tested via Playwright).

### 4.2 Playwright smoke

- Play. Verify `engine.playheadBeats()` advances at ~bpm/60 beats/second.
- Stop. Verify it freezes.
- Loop at beat 32. Verify the value drops below the prior value at the wrap (sample-accurate wrap inside the worklet).
- Verify `mB`/`mR` meters > 0 during play (drums/reverb buses receive audio).

---

## 5. Risks + open questions

- **Telemetry tearing.** Reading four u32s atomically requires either a snapshot block-counter (read it twice, retry if changed) or per-field `Atomics.load` (we already use that). Per-field is fine for a UI-driven RAF — the four fields don't need to be coherent down to the sample, only the *block*.
- **Playhead beats as f32.** Float32 represents integer beats up to ~16M exactly, which is plenty (1 hour at 124 BPM = ~7440 beats). Sub-beat resolution loses precision past ~16k beats — acceptable for v1.
- **Tempo + loop region in sample units.** Computed once on `SET_LOOP`; if BPM changes mid-play, the loop region in samples shifts but the worklet's `loopEndSamples` isn't recomputed until the next `SET_LOOP`. v1 sends `SET_LOOP` on every BPM change as a workaround. Cleaner Phase 7+.
- **Multi-destination cycles.** Already validated against in `topoSortChannels` (cycle channels are appended at the end). Fan-out doesn't introduce cycles by itself.

---

## 6. Decisions explicitly rejected

- **Re-baseline `playheadSamples` to `f64`** so it never wraps. v1 holds u32 (~24h 50m at 48kHz). Adequate.
- **One unified RAF loop in App.jsx.** Splitting transport reads from meter reads is fine — they have different cadences (transport benefits from synced reads; meters are envelope-followers that don't care). Consolidation is purely stylistic and can wait.
- **Send-level UI.** Phase 6b honours the seed's existing structure; per-send level sliders arrive when the Mixer pane learns about them.
