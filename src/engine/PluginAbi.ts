export const ABI_VERSION = 1 as const;

/** Names of the WASM exports the host calls. */
export const EXPORTS = {
  abi_version: 'noa_abi_version',
  init: 'noa_init',
  audio_in_ptr: 'noa_get_audio_in_ptr',
  audio_out_ptr: 'noa_get_audio_out_ptr',
  event_buf_ptr: 'noa_get_event_buf_ptr',
  event_buf_capacity: 'noa_event_buf_capacity',
  param_buf_ptr: 'noa_get_param_buf_ptr',
  param_count: 'noa_param_count',
  process: 'noa_process',
  state_size: 'noa_state_size',
  get_state: 'noa_get_state',
  set_state: 'noa_set_state',
  destroy: 'noa_destroy',

  // ABI v1.1: optional preset hot-swap exports. Plugins that don't ship the
  // full set fall back to the v1.0 noa_set_state path (which the worklet
  // expects to be O(memcpy)).
  preset_prepare: 'noa_preset_prepare',
  preset_get_state_size: 'noa_preset_get_state_size',
  preset_serialize: 'noa_preset_serialize',
  preset_free: 'noa_preset_free',
} as const;

/** The four v1.1 export names — either all present (preset support) or none. */
export const PRESET_EXPORTS: readonly (keyof typeof EXPORTS)[] = [
  'preset_prepare',
  'preset_get_state_size',
  'preset_serialize',
  'preset_free',
];

/** WASM linear-memory export name. Standard for AssemblyScript and most other toolchains. */
export const MEMORY_EXPORT = 'memory';
