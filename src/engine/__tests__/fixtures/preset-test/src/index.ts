// AssemblyScript ABI v1.1 preset-test fixture.
// Standard v1.0 surface (audio passthrough * A) + the four optional v1.1
// preset exports backed by a 4-slot fixed array.

const MAX_BLOCK: i32 = 2048;
const MAX_EVENTS: i32 = 256;
const PARAM_COUNT: i32 = 2;
const MAX_PRESETS: i32 = 4;

const audioIn  = new StaticArray<f32>(MAX_BLOCK * 2);
const audioOut = new StaticArray<f32>(MAX_BLOCK * 2);
const eventBuf = new StaticArray<u8>(MAX_EVENTS * 32);
const paramBuf = new StaticArray<f32>(PARAM_COUNT);

// Preset bank.
const presetUsed: StaticArray<bool> = new StaticArray<bool>(MAX_PRESETS);
const presetA:    StaticArray<f32>  = new StaticArray<f32>(MAX_PRESETS);
const presetB:    StaticArray<f32>  = new StaticArray<f32>(MAX_PRESETS);

export function noa_abi_version(): u32 { return 1; }

export function noa_init(sampleRate: u32, maxBlockSize: u32): u32 {
  if (maxBlockSize > <u32>MAX_BLOCK) return 0;
  for (let i: i32 = 0; i < MAX_PRESETS; i++) presetUsed[i] = false;
  return 1;
}

export function noa_get_audio_in_ptr():   u32 { return changetype<usize>(audioIn) as u32; }
export function noa_get_audio_out_ptr():  u32 { return changetype<usize>(audioOut) as u32; }
export function noa_get_event_buf_ptr():  u32 { return changetype<usize>(eventBuf) as u32; }
export function noa_event_buf_capacity(): u32 { return <u32>MAX_EVENTS; }
export function noa_get_param_buf_ptr():  u32 { return changetype<usize>(paramBuf) as u32; }
export function noa_param_count():        u32 { return <u32>PARAM_COUNT; }

export function noa_process(nFrames: u32, nEvents: u32): void {
  const a: f32 = paramBuf[0];
  const end: u32 = nFrames * 2;
  for (let i: u32 = 0; i < end; i++) audioOut[i] = audioIn[i] * a;
}

// v1.0 state: 8 bytes (two f32s).
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

export function noa_destroy(): void {}

// --- ABI v1.1 preset hot-swap ----------------------------------------------

// Preset payload: 4 bytes 'NTP1' + A f32 + B f32 = 12 bytes.
export function noa_preset_prepare(inPtr: u32, inLen: u32): u32 {
  if (inLen != 12) return 0;
  if (load<u8>(inPtr)     != 0x4E /* 'N' */) return 0;
  if (load<u8>(inPtr + 1) != 0x54 /* 'T' */) return 0;
  if (load<u8>(inPtr + 2) != 0x50 /* 'P' */) return 0;
  if (load<u8>(inPtr + 3) != 0x31 /* '1' */) return 0;
  for (let i: i32 = 0; i < MAX_PRESETS; i++) {
    if (!presetUsed[i]) {
      presetA[i] = load<f32>(inPtr + 4);
      presetB[i] = load<f32>(inPtr + 8);
      presetUsed[i] = true;
      return <u32>(i + 1); // 1-based
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
  store<f32>(outPtr, presetA[i]);
  store<f32>(outPtr + 4, presetB[i]);
  return 8;
}

export function noa_preset_free(handle: u32): void {
  const i: i32 = <i32>(handle - 1);
  if (i >= 0 && i < MAX_PRESETS) presetUsed[i] = false;
}
