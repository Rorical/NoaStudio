# Phase 7 — Audio-clip PCM playback + real WaveformView

**Status:** In progress (2026-06-11).

**Delivers:** Audio clips stop being UI-only stubs. A clip with a `sampleId` plays real PCM
through the engine, sample-accurately, routed through its track's channel (FX → fader → pan →
sends → master), and renders a real min/max waveform instead of a `Math.sin` blob. A bundled
**synth seed** sample makes the demo's Vox clips audible with zero binary assets; **drag-an-audio-file
import** lets users add their own samples.

This is the roadmap's deferred "audio clip PCM playback" + "WaveformView" items, built on one
shared decode/peaks pipeline. Per-channel meters were already shipped; multi-version is deferred.

## Decisions (locked)

- **PCM ownership:** decoded interleaved `Float32Array` lives in the worklet (`AudioClipPlayer`),
  shipped once via `LOAD_SAMPLE` with a transferable buffer. The coordinator never holds PCM.
- **Peaks:** computed on the main thread from the decoded PCM via `computePeaks` (Int8 min/max
  pairs), held in an in-memory `Map<sampleId, Int8Array>` in App.jsx, passed to Playlist. Not
  persisted in the project (recomputed/regenerated on boot — cheap).
- **Demo sample:** `generateDemoSample(sampleRate)` — deterministic, regenerated each boot from a
  `source: 'synth'` marker. No binary committed, fully unit-testable.
- **Imported sample persistence:** raw decoded PCM persisted to OPFS (`SampleStore`, mirrors
  `OpfsPluginStore`); reloaded + re-`loadSample`d on boot.
- **Scheduling:** a main-thread `AudioClipScheduler` mirrors `ClipScheduler` (anchor/horizon/
  loop-reset, `readCurrentSample` = `currentSamplePosition()`) and emits `EVT_AUDIO_ON/OFF` so
  audio events flow through the worklet's existing `dispatchPending` — identical timing to notes.
- **Routing:** an audio voice mixes into its channel's input bus alongside generator audio (via
  `MixerRouter` aux hook). It occupies no plugin slot. Channel mute/solo/pan/fader/sends apply for
  free; muting an audio track mirrors to its channel (existing convention) so it silences.
- **Schema:** bump `CURRENT_SCHEMA_VERSION` 3 → 4 (old projects reseed — no migration, per policy).

## Event frames (EngineEvent.ts)

- `EVT_AUDIO_ON = 6`: payload voiceId u32@8, sampleHash u32@12, channelHash u32@16,
  startFrame u32@20, gain f32@24. (`sampleHash`/`channelHash` = `channelHash(id)` — generic FNV-1a.)
- `EVT_AUDIO_OFF = 7`: payload voiceId u32@8.

## Components

| File | Change |
|---|---|
| `src/engine/computePeaks.ts` | ✅ done — `computePeaks(Float32Array, binCount): Int8Array` |
| `src/engine/generateDemoSample.ts` | ✅ done — deterministic stereo demo PCM |
| `src/engine/EngineEvent.ts` | + `EVT_AUDIO_ON/OFF` types, encode/decode |
| `src/engine/AudioClipPlayer.ts` | NEW — worklet-side sample store + active voices; `render(blockSize, mixInto)` |
| `src/engine/MixerRouter.ts` | + optional `aux` arg to `processBlock`; `channelByHash` map; render aux after generator loop |
| `src/engine/audio-worklet.ts` | own an `AudioClipPlayer`; handle `LOAD_SAMPLE`/`UNLOAD_SAMPLE`; route AUDIO_ON/OFF in `dispatchPending`; pass player to `processBlock` |
| `src/engine/AudioClipScheduler.ts` | NEW — look-ahead audio-clip sequencer (mirror ClipScheduler) |
| `src/engine/EngineClient.ts` | + `loadSample`/`unloadSample` |
| `src/engine/WorkletProtocol.ts` | + `loadSample`/`unloadSample` (transfer pcm buffer) |
| `src/coordinator/projectModel.ts` | + `Sample`; `Clip.sampleId`; `Project.samples`; schema 4 |
| `src/coordinator/actions.ts` + `reducer.ts` | + `IMPORT_AUDIO { sample, clip }` |
| `src/data.js` | + `DEMO_SAMPLES`; attach `sampleId` to c24/c25 |
| `src/sw/SampleStore.ts` (or engine) | NEW — OPFS persistence for imported PCM |
| `src/App.jsx` | materialize samples → peaks + loadSample; `AudioClipScheduler` in transport RAF; pass `samplePeaks` to Playlist; file-drop import |
| `src/components/Playlist.jsx` | thread peaks; rewrite `ClipWaveform` to draw real min/max |

## Increments

- **A — core (synth seed):** model + seed + EngineEvent + AudioClipPlayer + MixerRouter aux +
  worklet + AudioClipScheduler + EngineClient/WorkletProtocol + App wiring + WaveformView. Demo
  Vox clips play + show a real waveform.
- **B — file import:** `SampleStore` (OPFS) + decode helper + `IMPORT_AUDIO` + drag-a-file-onto-track
  UI + boot reload of imported samples.

## Testing

Pure units unit-tested (Vitest/Node): computePeaks ✅, generateDemoSample ✅, EngineEvent audio
frames, AudioClipPlayer (voice cursor/mix/auto-stop), AudioClipScheduler (scan/emit/stop/reset),
reducer (IMPORT_AUDIO). Anything touching AudioContext/iframe = manual browser smoke test.
