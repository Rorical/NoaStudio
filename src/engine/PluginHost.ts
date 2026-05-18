import { ABI_VERSION, EXPORTS, MEMORY_EXPORT } from './PluginAbi';
import type { PluginManifest } from './PluginManifest';

export interface HostInitOpts {
  sampleRate: number;
  maxBlockSize: number;
  hostImports?: Partial<HostImports>;
}

export interface HostImports {
  log: (ptr: number, len: number) => void;
  random: () => number;
  get_tempo: () => number;
}

const DEFAULT_IMPORTS: HostImports = {
  log: () => {},
  random: () => Math.random(),
  get_tempo: () => 120,
};

type WasmFn = (...args: number[]) => number | void;

interface PluginExports {
  [EXPORTS.abi_version]:        () => number;
  [EXPORTS.init]:               (sr: number, mbs: number) => number;
  [EXPORTS.audio_in_ptr]:       () => number;
  [EXPORTS.audio_out_ptr]:      () => number;
  [EXPORTS.event_buf_ptr]:      () => number;
  [EXPORTS.event_buf_capacity]: () => number;
  [EXPORTS.param_buf_ptr]:      () => number;
  [EXPORTS.param_count]:        () => number;
  [EXPORTS.process]:            (nFrames: number, nEvents: number) => void;
  [EXPORTS.state_size]:         () => number;
  [EXPORTS.get_state]:          (outPtr: number) => number;
  [EXPORTS.set_state]:          (inPtr: number, nBytes: number) => number;
  [EXPORTS.destroy]:            () => void;
  [MEMORY_EXPORT]:              WebAssembly.Memory;
  [k: string]: WasmFn | WebAssembly.Memory;
}

/**
 * Main-thread WASM plugin runner. Used by tests + offline tooling.
 * The worklet has its own analogue (PluginInstance) so it can run in the worklet's
 * global scope; the two implementations share the same ABI contract.
 */
export class PluginHost {
  readonly manifest: PluginManifest;
  readonly memory: WebAssembly.Memory;
  readonly maxBlockSize: number;
  readonly sampleRate: number;

  private readonly exports: PluginExports;
  private readonly audioInPtr: number;
  private readonly audioOutPtr: number;
  private readonly eventBufPtr: number;
  private readonly eventBufCapacity: number;
  private readonly paramBufPtr: number;
  private readonly paramCount: number;
  private readonly stateScratchPtr: number;
  private destroyed = false;

  static async fromBytes(
    bytes: BufferSource,
    manifest: PluginManifest,
    opts: HostInitOpts,
  ): Promise<PluginHost> {
    const module = await WebAssembly.compile(bytes);
    return PluginHost.fromModule(module, manifest, opts);
  }

  static async fromModule(
    module: WebAssembly.Module,
    manifest: PluginManifest,
    opts: HostInitOpts,
  ): Promise<PluginHost> {
    const imports = { ...DEFAULT_IMPORTS, ...(opts.hostImports ?? {}) };
    const instance = await WebAssembly.instantiate(module, {
      host: imports,
      // AssemblyScript's stub runtime references `abort` from `env`.
      env: { abort: () => { throw new Error(`plugin '${manifest.id}' aborted`); } },
    });
    return new PluginHost(instance.exports as unknown as PluginExports, manifest, opts);
  }

  private constructor(
    exports: PluginExports,
    manifest: PluginManifest,
    opts: HostInitOpts,
  ) {
    this.exports = exports;
    this.manifest = manifest;
    this.memory = exports[MEMORY_EXPORT] as WebAssembly.Memory;
    this.sampleRate = opts.sampleRate;
    this.maxBlockSize = opts.maxBlockSize;

    const v = exports[EXPORTS.abi_version]();
    if (v !== ABI_VERSION) {
      throw new Error(`PluginHost: WASM noa_abi_version()=${v} != host ${ABI_VERSION}`);
    }
    const ok = exports[EXPORTS.init](opts.sampleRate, opts.maxBlockSize);
    if (ok !== 1) throw new Error(`PluginHost: noa_init returned ${ok}`);

    this.audioInPtr        = exports[EXPORTS.audio_in_ptr]();
    this.audioOutPtr       = exports[EXPORTS.audio_out_ptr]();
    this.eventBufPtr       = exports[EXPORTS.event_buf_ptr]();
    this.eventBufCapacity  = exports[EXPORTS.event_buf_capacity]();
    this.paramBufPtr       = exports[EXPORTS.param_buf_ptr]();
    this.paramCount        = exports[EXPORTS.param_count]();
    // Reuse the audio-in slot for get_state / set_state scratch. Safe between blocks.
    this.stateScratchPtr   = this.audioInPtr;

    if (this.paramCount !== manifest.params.length) {
      throw new Error(
        `PluginHost: manifest declares ${manifest.params.length} params but module exports ${this.paramCount}`,
      );
    }
  }

  setParam(index: number, value: number): void {
    if (this.destroyed) return;
    if (index < 0 || index >= this.paramCount) {
      throw new Error(`PluginHost.setParam: index ${index} out of range [0, ${this.paramCount})`);
    }
    const view = new Float32Array(this.memory.buffer, this.paramBufPtr + index * 4, 1);
    view[0] = value;
  }

  readParam(index: number): number {
    if (index < 0 || index >= this.paramCount) {
      throw new Error(`PluginHost.readParam: index ${index} out of range [0, ${this.paramCount})`);
    }
    const view = new Float32Array(this.memory.buffer, this.paramBufPtr + index * 4, 1);
    return view[0]!;
  }

  pushEvents(frames: Uint8Array, count: number): void {
    if (count > this.eventBufCapacity) {
      throw new Error(`PluginHost.pushEvents: ${count} > capacity ${this.eventBufCapacity}`);
    }
    if (frames.length < count * 32) {
      throw new Error('PluginHost.pushEvents: source frames buffer too small');
    }
    const dst = new Uint8Array(this.memory.buffer, this.eventBufPtr, count * 32);
    dst.set(frames.subarray(0, count * 32));
  }

  writeInput(samples: Float32Array): void {
    if (samples.length > this.maxBlockSize * 2) {
      throw new Error(`PluginHost.writeInput: ${samples.length} > ${this.maxBlockSize * 2}`);
    }
    const dst = new Float32Array(this.memory.buffer, this.audioInPtr, samples.length);
    dst.set(samples);
  }

  readOutput(out: Float32Array): void {
    if (out.length > this.maxBlockSize * 2) {
      throw new Error(`PluginHost.readOutput: ${out.length} > ${this.maxBlockSize * 2}`);
    }
    const src = new Float32Array(this.memory.buffer, this.audioOutPtr, out.length);
    out.set(src);
  }

  process(nFrames: number, nEvents: number): void {
    if (this.destroyed) return;
    if (nFrames > this.maxBlockSize) {
      throw new Error(`PluginHost.process: nFrames ${nFrames} > maxBlockSize ${this.maxBlockSize}`);
    }
    this.exports[EXPORTS.process](nFrames, nEvents);
  }

  getState(): Uint8Array {
    const size = this.exports[EXPORTS.state_size]();
    if (size === 0) return new Uint8Array(0);
    const bytesWritten = this.exports[EXPORTS.get_state](this.stateScratchPtr);
    // Copy out of plugin memory so the result survives later writes.
    return new Uint8Array(new Uint8Array(this.memory.buffer, this.stateScratchPtr, bytesWritten));
  }

  setState(bytes: Uint8Array): boolean {
    if (bytes.length === 0) return true;
    const dst = new Uint8Array(this.memory.buffer, this.stateScratchPtr, bytes.length);
    dst.set(bytes);
    return this.exports[EXPORTS.set_state](this.stateScratchPtr, bytes.length) === 1;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.exports[EXPORTS.destroy]();
    this.destroyed = true;
  }
}
