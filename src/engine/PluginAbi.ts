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
} as const;

/** WASM linear-memory export name. Standard for AssemblyScript and most other toolchains. */
export const MEMORY_EXPORT = 'memory';
