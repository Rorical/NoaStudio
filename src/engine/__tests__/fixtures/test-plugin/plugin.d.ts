declare namespace __AdaptedExports {
  /** Exported memory */
  export const memory: WebAssembly.Memory;
  /**
   * src/index/noa_abi_version
   * @returns `u32`
   */
  export function noa_abi_version(): number;
  /**
   * src/index/noa_init
   * @param sampleRate `u32`
   * @param maxBlockSize `u32`
   * @returns `u32`
   */
  export function noa_init(sampleRate: number, maxBlockSize: number): number;
  /**
   * src/index/noa_get_audio_in_ptr
   * @returns `u32`
   */
  export function noa_get_audio_in_ptr(): number;
  /**
   * src/index/noa_get_audio_out_ptr
   * @returns `u32`
   */
  export function noa_get_audio_out_ptr(): number;
  /**
   * src/index/noa_get_event_buf_ptr
   * @returns `u32`
   */
  export function noa_get_event_buf_ptr(): number;
  /**
   * src/index/noa_event_buf_capacity
   * @returns `u32`
   */
  export function noa_event_buf_capacity(): number;
  /**
   * src/index/noa_get_param_buf_ptr
   * @returns `u32`
   */
  export function noa_get_param_buf_ptr(): number;
  /**
   * src/index/noa_param_count
   * @returns `u32`
   */
  export function noa_param_count(): number;
  /**
   * src/index/noa_process
   * @param nFrames `u32`
   * @param nEvents `u32`
   */
  export function noa_process(nFrames: number, nEvents: number): void;
  /**
   * src/index/noa_state_size
   * @returns `u32`
   */
  export function noa_state_size(): number;
  /**
   * src/index/noa_get_state
   * @param outPtr `u32`
   * @returns `u32`
   */
  export function noa_get_state(outPtr: number): number;
  /**
   * src/index/noa_set_state
   * @param inPtr `u32`
   * @param nBytes `u32`
   * @returns `u32`
   */
  export function noa_set_state(inPtr: number, nBytes: number): number;
  /**
   * src/index/noa_destroy
   */
  export function noa_destroy(): void;
}
/** Instantiates the compiled WebAssembly module with the given imports. */
export declare function instantiate(module: WebAssembly.Module, imports: {
  env: unknown,
}): Promise<typeof __AdaptedExports>;
