// AssemblyScript. Compile with:
//   npx asc src/index.ts -o plugin.wasm --runtime stub --optimize
// Built artifact (plugin.wasm) is committed; rebuild with ./scripts/build-plugins.sh.

const MAX_BLOCK: i32 = 2048;
const MAX_EVENTS: i32 = 256;
const PARAM_COUNT: i32 = 1;

// Static buffers, preallocated as global typed arrays.
const audioIn = new StaticArray<f32>(MAX_BLOCK * 2);
const audioOut = new StaticArray<f32>(MAX_BLOCK * 2);
const eventBuf = new StaticArray<u8>(MAX_EVENTS * 32);
const paramBuf = new StaticArray<f32>(PARAM_COUNT);

let initialized: bool = false;
let lastSeenSampleRate: u32 = 0;

export function noa_abi_version(): u32 { return 1; }

export function noa_init(sampleRate: u32, maxBlockSize: u32): u32 {
  if (maxBlockSize > <u32>MAX_BLOCK) return 0;
  initialized = true;
  lastSeenSampleRate = sampleRate;
  paramBuf[0] = 1.0;
  return 1;
}

export function noa_get_audio_in_ptr():     u32 { return changetype<usize>(audioIn) as u32; }
export function noa_get_audio_out_ptr():    u32 { return changetype<usize>(audioOut) as u32; }
export function noa_get_event_buf_ptr():    u32 { return changetype<usize>(eventBuf) as u32; }
export function noa_event_buf_capacity():   u32 { return <u32>MAX_EVENTS; }
export function noa_get_param_buf_ptr():    u32 { return changetype<usize>(paramBuf) as u32; }
export function noa_param_count():          u32 { return <u32>PARAM_COUNT; }

export function noa_process(nFrames: u32, nEvents: u32): void {
  if (!initialized) return;
  const volume: f32 = paramBuf[0];
  const end: u32 = nFrames * 2;
  for (let i: u32 = 0; i < end; i++) {
    audioOut[i] = audioIn[i] * volume;
  }
}

export function noa_state_size(): u32 { return 4; }

export function noa_get_state(outPtr: u32): u32 {
  store<f32>(outPtr, paramBuf[0]);
  return 4;
}

export function noa_set_state(inPtr: u32, nBytes: u32): u32 {
  if (nBytes != 4) return 0;
  paramBuf[0] = load<f32>(inPtr);
  return 1;
}

export function noa_destroy(): void { initialized = false; }
