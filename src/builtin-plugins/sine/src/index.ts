// AssemblyScript: 8-voice polyphonic sine generator.
// ABI v1 — replaces the Phase 1 dsp/SineGenerator class.
//
// Rebuild with: ./scripts/build-plugins.sh

const MAX_BLOCK: i32 = 2048;
const MAX_EVENTS: i32 = 256;
const PARAM_COUNT: i32 = 2;
const MAX_VOICES: i32 = 8;
const RELEASE_PER_SAMPLE: f32 = 1e-3;
const MASTER_TRIM: f32 = 0.5;

const audioIn  = new StaticArray<f32>(MAX_BLOCK * 2);
const audioOut = new StaticArray<f32>(MAX_BLOCK * 2);
const eventBuf = new StaticArray<u8>(MAX_EVENTS * 32);
const paramBuf = new StaticArray<f32>(PARAM_COUNT);

// Parallel voice state. AS doesn't give us cheap struct arrays, so this is the
// flat form. Voices are claimed by linear scan; voice 0 is stolen if all busy.
const vActive    = new StaticArray<bool>(MAX_VOICES);
const vReleasing = new StaticArray<bool>(MAX_VOICES);
const vNote      = new StaticArray<u8>(MAX_VOICES);
const vFreq      = new StaticArray<f32>(MAX_VOICES);
const vPhase     = new StaticArray<f32>(MAX_VOICES);
const vAmp       = new StaticArray<f32>(MAX_VOICES);

let sr: f32 = 48000.0;

const EVT_NOTE_ON:  u8 = 1;
const EVT_NOTE_OFF: u8 = 2;

const TWO_PI: f32 = <f32>Math.PI * 2.0;

export function noa_abi_version(): u32 { return 1; }

export function noa_init(sampleRate: u32, maxBlockSize: u32): u32 {
  if (maxBlockSize > <u32>MAX_BLOCK) return 0;
  sr = <f32>sampleRate;
  paramBuf[0] = 0.5; // Volume
  paramBuf[1] = 0;   // Octave
  for (let i: i32 = 0; i < MAX_VOICES; i++) {
    vActive[i] = false;
    vReleasing[i] = false;
    vAmp[i] = 0;
    vPhase[i] = 0;
  }
  return 1;
}

export function noa_get_audio_in_ptr():   u32 { return changetype<usize>(audioIn) as u32; }
export function noa_get_audio_out_ptr():  u32 { return changetype<usize>(audioOut) as u32; }
export function noa_get_event_buf_ptr():  u32 { return changetype<usize>(eventBuf) as u32; }
export function noa_event_buf_capacity(): u32 { return <u32>MAX_EVENTS; }
export function noa_get_param_buf_ptr():  u32 { return changetype<usize>(paramBuf) as u32; }
export function noa_param_count():        u32 { return <u32>PARAM_COUNT; }

function midiToFreq(midi: f32): f32 {
  return 440.0 * Mathf.pow(2.0, (midi - 69.0) / 12.0);
}

function startVoice(note: u8, velocity: u8): void {
  let slot: i32 = -1;
  for (let i: i32 = 0; i < MAX_VOICES; i++) {
    if (!vActive[i]) { slot = i; break; }
  }
  if (slot < 0) slot = 0;

  const octave: i32 = <i32>paramBuf[1];
  let shifted: i32 = <i32>note + octave * 12;
  if (shifted < 0) shifted = 0;
  if (shifted > 127) shifted = 127;

  vActive[slot] = true;
  vReleasing[slot] = false;
  vNote[slot] = note;
  vFreq[slot] = midiToFreq(<f32>shifted);
  vAmp[slot] = <f32>velocity / 127.0;
  vPhase[slot] = 0;
}

function releaseVoices(note: u8): void {
  for (let i: i32 = 0; i < MAX_VOICES; i++) {
    if (vActive[i] && vNote[i] == note) vReleasing[i] = true;
  }
}

function applyEvent(idx: i32): void {
  const base: usize = changetype<usize>(eventBuf) + idx * 32;
  const type: u8 = load<u8>(base);
  if (type == EVT_NOTE_ON) {
    const note: u8 = load<u8>(base, 12);
    const velocity: u8 = load<u8>(base, 13);
    startVoice(note, velocity);
  } else if (type == EVT_NOTE_OFF) {
    const note: u8 = load<u8>(base, 12);
    releaseVoices(note);
  }
}

function eventFrameOffset(idx: i32): u32 {
  return load<u32>(changetype<usize>(eventBuf) + idx * 32, 4);
}

export function noa_process(nFrames: u32, nEvents: u32): void {
  const volume: f32 = paramBuf[0];
  const masterGain: f32 = volume * MASTER_TRIM;
  let eventIdx: u32 = 0;

  for (let i: u32 = 0; i < nFrames; i++) {
    // Fire any events whose frameOffset is <= the current sample.
    while (eventIdx < nEvents && eventFrameOffset(<i32>eventIdx) <= i) {
      applyEvent(<i32>eventIdx);
      eventIdx++;
    }

    let sample: f32 = 0;
    for (let vi: i32 = 0; vi < MAX_VOICES; vi++) {
      if (!vActive[vi]) continue;
      sample += Mathf.sin(vPhase[vi] * TWO_PI) * vAmp[vi];
      vPhase[vi] += vFreq[vi] / sr;
      if (vPhase[vi] >= 1.0) vPhase[vi] -= 1.0;
      if (vReleasing[vi]) {
        vAmp[vi] -= RELEASE_PER_SAMPLE;
        if (vAmp[vi] <= 0) {
          vActive[vi] = false;
          vReleasing[vi] = false;
          vAmp[vi] = 0;
        }
      }
    }

    const out: f32 = sample * masterGain;
    audioOut[i * 2]     = out;
    audioOut[i * 2 + 1] = out;
  }

  // Drain leftover events (frameOffset >= nFrames is rare but legal).
  while (eventIdx < nEvents) {
    applyEvent(<i32>eventIdx);
    eventIdx++;
  }
}

export function noa_state_size(): u32 { return 8; }

export function noa_get_state(outPtr: u32): u32 {
  store<f32>(outPtr, paramBuf[0]);
  store<f32>(outPtr + 4, paramBuf[1]);
  return 8;
}

export function noa_set_state(inPtr: u32, nBytes: u32): u32 {
  if (nBytes != 8) return 0;
  paramBuf[0] = load<f32>(inPtr);
  paramBuf[1] = load<f32>(inPtr + 4);
  return 1;
}

export function noa_destroy(): void {
  for (let i: i32 = 0; i < MAX_VOICES; i++) {
    vActive[i] = false;
    vReleasing[i] = false;
    vAmp[i] = 0;
  }
}

// --- ABI v1.1 preset hot-swap ----------------------------------------------
//
// Preset payload: 12 bytes — 'NSP1' magic (4B) + Volume f32 + Octave f32.
// Up to 4 prepared presets can be held at a time. A handle is the 1-based slot
// index. noa_preset_prepare burns ~PRESET_DELAY_ITERS cycles to simulate slow
// parsing — this is the value-prove: the worker absorbs it while the worklet
// keeps rendering audio uninterrupted.

const MAX_PRESETS: i32 = 4;
/**
 * Empty-loop iteration count tuned to ~30ms on modern hardware. Used purely
 * as a "this would block the audio thread if you ran it there" demo.
 */
const PRESET_DELAY_ITERS: i32 = 30_000_000;

const presetUsed:   StaticArray<bool> = new StaticArray<bool>(MAX_PRESETS);
const presetVolume: StaticArray<f32>  = new StaticArray<f32>(MAX_PRESETS);
const presetOctave: StaticArray<f32>  = new StaticArray<f32>(MAX_PRESETS);

export function noa_preset_prepare(inPtr: u32, inLen: u32): u32 {
  if (inLen != 12) return 0;
  // Magic check: 'NSP1'
  if (load<u8>(inPtr)     != 0x4E) return 0;
  if (load<u8>(inPtr + 1) != 0x53) return 0;
  if (load<u8>(inPtr + 2) != 0x50) return 0;
  if (load<u8>(inPtr + 3) != 0x31) return 0;
  for (let i: i32 = 0; i < MAX_PRESETS; i++) {
    if (!presetUsed[i]) {
      presetVolume[i] = load<f32>(inPtr + 4);
      presetOctave[i] = load<f32>(inPtr + 8);
      presetUsed[i]   = true;
      // Synthetic parse-time delay. Replace with real work in a real plugin.
      for (let j: i32 = 0; j < PRESET_DELAY_ITERS; j++) {
        // Memory write keeps the optimizer from eliding the loop.
        if ((j & 0xFFFFFF) == 0) presetVolume[0] = presetVolume[0];
      }
      return <u32>(i + 1);
    }
  }
  return 0;
}

export function noa_preset_get_state_size(handle: u32): u32 {
  const i: i32 = <i32>(handle - 1);
  if (i < 0 || i >= MAX_PRESETS || !presetUsed[i]) return 0;
  return 8;
}

export function noa_preset_serialize(handle: u32, outPtr: u32): u32 {
  const i: i32 = <i32>(handle - 1);
  if (i < 0 || i >= MAX_PRESETS || !presetUsed[i]) return 0;
  store<f32>(outPtr, presetVolume[i]);
  store<f32>(outPtr + 4, presetOctave[i]);
  return 8;
}

export function noa_preset_free(handle: u32): void {
  const i: i32 = <i32>(handle - 1);
  if (i >= 0 && i < MAX_PRESETS) presetUsed[i] = false;
}
