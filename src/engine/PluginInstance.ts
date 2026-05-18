import { ABI_VERSION, EXPORTS, MEMORY_EXPORT, PRESET_EXPORTS } from './PluginAbi';
import type { PluginManifest } from './PluginManifest';
import { allocRingBuffer, RingBuffer } from './RingBuffer';
import {
  EVENT_FRAME_SIZE,
  EVT_PARAM_SET,
} from './EngineEvent';

export interface PluginInitOpts {
  sampleRate: number;
  maxBlockSize: number;
  hostImports?: Partial<HostImports>;
  /** When true, allocates per-instance event + notify rings exposed as SABs. */
  allocateRings?: boolean;
  /** Initial values copied into the plugin's param buffer after `noa_init`. */
  initialParams?: readonly number[];
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

/** UI→engine event ring: 1024 slots × 32-byte EngineEvent frames. */
const PARAM_RING_SLOTS = 1024;
/** engine→UI notify ring: 256 slots × 16-byte ParamChanged frames. */
const NOTIFY_RING_SLOTS = 256;
const NOTIFY_FRAME_SIZE = 16;

/** Notify frame type discriminants. */
export const NOTIFY_PARAM_CHANGED = 1;

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
  // ABI v1.1 — optional. Either all four are present or none.
  [EXPORTS.preset_prepare]?:        (inPtr: number, inLen: number) => number;
  [EXPORTS.preset_get_state_size]?: (handle: number) => number;
  [EXPORTS.preset_serialize]?:      (handle: number, outPtr: number) => number;
  [EXPORTS.preset_free]?:           (handle: number) => void;
  [MEMORY_EXPORT]:              WebAssembly.Memory;
  [k: string]: WasmFn | WebAssembly.Memory | undefined;
}

function buildImports(manifestId: string, hostImports: Partial<HostImports> | undefined): WebAssembly.Imports {
  const imports = { ...DEFAULT_IMPORTS, ...(hostImports ?? {}) };
  return {
    host: imports as unknown as Record<string, WebAssembly.ImportValue>,
    env: { abort: () => { throw new Error(`plugin '${manifestId}' aborted`); } },
  };
}

/**
 * One running WASM plugin. Same class powers main-thread unit tests
 * (via `fromBytes`, async) and the audio worklet (via `fromModule`, sync).
 *
 * When constructed with `allocateRings: true` the instance also owns:
 *   - `paramRingSab`  — UI→engine ring of 32-byte EngineEvent frames
 *   - `notifyRingSab` — engine→UI ring of 16-byte ParamChanged frames
 *
 * The two SABs are exposed publicly so the host can hand them to a plugin's
 * UI iframe via postMessage. Reading and writing from inside the instance is
 * done through `drainParamRing()` and `pushNotifyParamChanged()`.
 */
export class PluginInstance {
  readonly manifest: PluginManifest;
  readonly memory: WebAssembly.Memory;
  readonly maxBlockSize: number;
  readonly sampleRate: number;

  /** Allocated when `allocateRings: true`. Read this from the host to hand to a UI. */
  readonly paramRingSab: SharedArrayBuffer | null;
  /** Allocated when `allocateRings: true`. UI polls this for external param changes. */
  readonly notifyRingSab: SharedArrayBuffer | null;

  private readonly exports: PluginExports;
  private readonly audioInPtr: number;
  private readonly audioOutPtr: number;
  private readonly eventBufPtr: number;
  private readonly eventBufCapacity: number;
  private readonly paramBufPtr: number;
  private readonly paramCount: number;
  private readonly stateScratchPtr: number;

  private readonly paramRing: RingBuffer | null;
  private readonly notifyRing: RingBuffer | null;
  private readonly notifyFrame: Uint8Array;
  private readonly notifyView: DataView;
  private readonly drainFrame: Uint8Array;

  private destroyed = false;

  /**
   * Synchronous factory. Use this from the AudioWorklet (where `new WebAssembly.Instance`
   * is allowed but `WebAssembly.instantiate` returns a Promise that the worklet can't await).
   */
  static fromModule(
    module: WebAssembly.Module,
    manifest: PluginManifest,
    opts: PluginInitOpts,
  ): PluginInstance {
    const instance = new WebAssembly.Instance(module, buildImports(manifest.id, opts.hostImports));
    return new PluginInstance(instance.exports as unknown as PluginExports, manifest, opts);
  }

  /** Async convenience: compile bytes then instantiate. Used by Node-based tests. */
  static async fromBytes(
    bytes: BufferSource,
    manifest: PluginManifest,
    opts: PluginInitOpts,
  ): Promise<PluginInstance> {
    const module = await WebAssembly.compile(bytes);
    return PluginInstance.fromModule(module, manifest, opts);
  }

  private constructor(
    exports: PluginExports,
    manifest: PluginManifest,
    opts: PluginInitOpts,
  ) {
    this.exports = exports;
    this.manifest = manifest;
    this.memory = exports[MEMORY_EXPORT] as WebAssembly.Memory;
    this.sampleRate = opts.sampleRate;
    this.maxBlockSize = opts.maxBlockSize;

    const v = exports[EXPORTS.abi_version]();
    if (v !== ABI_VERSION) {
      throw new Error(`PluginInstance: WASM noa_abi_version()=${v} != host ${ABI_VERSION}`);
    }
    const ok = exports[EXPORTS.init](opts.sampleRate, opts.maxBlockSize);
    if (ok !== 1) throw new Error(`PluginInstance: noa_init returned ${ok}`);

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
        `PluginInstance: manifest declares ${manifest.params.length} params but module exports ${this.paramCount}`,
      );
    }

    // Apply initial param values *before* the host caches them for the first block.
    if (opts.initialParams) {
      const n = Math.min(opts.initialParams.length, this.paramCount);
      const view = new Float32Array(this.memory.buffer, this.paramBufPtr, this.paramCount);
      for (let i = 0; i < n; i++) view[i] = opts.initialParams[i]!;
    }

    if (opts.allocateRings) {
      const param = allocRingBuffer(PARAM_RING_SLOTS, EVENT_FRAME_SIZE);
      const notify = allocRingBuffer(NOTIFY_RING_SLOTS, NOTIFY_FRAME_SIZE);
      this.paramRingSab = param.sab;
      this.notifyRingSab = notify.sab;
      this.paramRing = new RingBuffer(param.sab);
      this.notifyRing = new RingBuffer(notify.sab);
      this.notifyFrame = new Uint8Array(NOTIFY_FRAME_SIZE);
      this.notifyView = new DataView(this.notifyFrame.buffer);
      this.drainFrame = new Uint8Array(EVENT_FRAME_SIZE);
    } else {
      this.paramRingSab = null;
      this.notifyRingSab = null;
      this.paramRing = null;
      this.notifyRing = null;
      this.notifyFrame = new Uint8Array(0);
      this.notifyView = new DataView(this.notifyFrame.buffer);
      this.drainFrame = new Uint8Array(0);
    }
  }

  setParam(index: number, value: number): void {
    if (this.destroyed) return;
    if (index < 0 || index >= this.paramCount) {
      throw new Error(`PluginInstance.setParam: index ${index} out of range [0, ${this.paramCount})`);
    }
    const view = new Float32Array(this.memory.buffer, this.paramBufPtr + index * 4, 1);
    view[0] = value;
  }

  readParam(index: number): number {
    if (index < 0 || index >= this.paramCount) {
      throw new Error(`PluginInstance.readParam: index ${index} out of range [0, ${this.paramCount})`);
    }
    const view = new Float32Array(this.memory.buffer, this.paramBufPtr + index * 4, 1);
    return view[0]!;
  }

  pushEvents(frames: Uint8Array, count: number): void {
    if (count > this.eventBufCapacity) {
      throw new Error(`PluginInstance.pushEvents: ${count} > capacity ${this.eventBufCapacity}`);
    }
    if (frames.length < count * EVENT_FRAME_SIZE) {
      throw new Error('PluginInstance.pushEvents: source frames buffer too small');
    }
    const dst = new Uint8Array(this.memory.buffer, this.eventBufPtr, count * EVENT_FRAME_SIZE);
    dst.set(frames.subarray(0, count * EVENT_FRAME_SIZE));
  }

  writeInput(samples: Float32Array): void {
    if (samples.length > this.maxBlockSize * 2) {
      throw new Error(`PluginInstance.writeInput: ${samples.length} > ${this.maxBlockSize * 2}`);
    }
    const dst = new Float32Array(this.memory.buffer, this.audioInPtr, samples.length);
    dst.set(samples);
  }

  readOutput(out: Float32Array): void {
    if (out.length > this.maxBlockSize * 2) {
      throw new Error(`PluginInstance.readOutput: ${out.length} > ${this.maxBlockSize * 2}`);
    }
    const src = new Float32Array(this.memory.buffer, this.audioOutPtr, out.length);
    out.set(src);
  }

  process(nFrames: number, nEvents: number): void {
    if (this.destroyed) return;
    if (nFrames > this.maxBlockSize) {
      throw new Error(`PluginInstance.process: nFrames ${nFrames} > maxBlockSize ${this.maxBlockSize}`);
    }
    this.exports[EXPORTS.process](nFrames, nEvents);
  }

  /**
   * Drain the UI→engine event ring (when rings are allocated). For each
   * ParamSet frame, write the new value into the plugin's param buffer.
   * Other event types in the param ring are ignored (UI is the source).
   * Returns the number of frames drained this call.
   */
  drainParamRing(): number {
    if (!this.paramRing) return 0;
    let drained = 0;
    while (this.paramRing.pop(this.drainFrame)) {
      // Peek the type byte at offset 0 — same EngineEvent layout as the global ring.
      if (this.drainFrame[0] === EVT_PARAM_SET) {
        const view = new DataView(
          this.drainFrame.buffer,
          this.drainFrame.byteOffset,
          this.drainFrame.byteLength,
        );
        const paramIndex = view.getUint32(12, true);
        const value = view.getFloat32(16, true);
        if (paramIndex < this.paramCount) {
          const paramView = new Float32Array(this.memory.buffer, this.paramBufPtr + paramIndex * 4, 1);
          paramView[0] = value;
        }
      }
      drained++;
    }
    return drained;
  }

  /**
   * Push a ParamChanged notification to the UI for an externally-driven change
   * (mixer fader, automation, preset load). No-op when rings are not allocated.
   * Returns true if the frame was enqueued; false if the notify ring was full.
   */
  pushNotifyParamChanged(paramIndex: number, value: number, blockCounter: number): boolean {
    if (!this.notifyRing) return false;
    if (paramIndex < 0 || paramIndex >= this.paramCount) return false;
    this.notifyView.setUint8(0, NOTIFY_PARAM_CHANGED);
    // bytes 1..4 reserved
    this.notifyView.setUint32(4, paramIndex, true);
    this.notifyView.setFloat32(8, value, true);
    this.notifyView.setUint32(12, blockCounter >>> 0, true);
    return this.notifyRing.push(this.notifyFrame);
  }

  getState(): Uint8Array {
    const size = this.exports[EXPORTS.state_size]();
    if (size === 0) return new Uint8Array(0);
    const bytesWritten = this.exports[EXPORTS.get_state](this.stateScratchPtr);
    return new Uint8Array(new Uint8Array(this.memory.buffer, this.stateScratchPtr, bytesWritten));
  }

  setState(bytes: Uint8Array): boolean {
    if (bytes.length === 0) return true;
    const dst = new Uint8Array(this.memory.buffer, this.stateScratchPtr, bytes.length);
    dst.set(bytes);
    return this.exports[EXPORTS.set_state](this.stateScratchPtr, bytes.length) === 1;
  }

  /**
   * Returns true when the plugin exports all four ABI v1.1 preset symbols
   * (`noa_preset_prepare`, `noa_preset_get_state_size`,
   * `noa_preset_serialize`, `noa_preset_free`).
   */
  hasPresetSupport(): boolean {
    return PRESET_EXPORTS.every((k) => typeof this.exports[EXPORTS[k]] === 'function');
  }

  private assertPresetSupport(method: string): void {
    if (!this.hasPresetSupport()) {
      throw new Error(`PluginInstance.${method}: plugin has no preset support (missing ABI v1.1 exports)`);
    }
  }

  /**
   * Worker-side call: parse `bytes` into a prepared "hot" preset. Slow path —
   * may take arbitrarily long depending on the plugin. Returns a non-zero
   * handle on success. Throws if the plugin doesn't ship v1.1 or rejects
   * the payload.
   */
  preparePreset(bytes: Uint8Array): number {
    this.assertPresetSupport('preparePreset');
    if (bytes.length > this.eventBufCapacity * 32) {
      throw new Error(`PluginInstance.preparePreset: preset bytes ${bytes.length} exceed scratch capacity`);
    }
    // Reuse the event buffer as scratch for preset bytes — it's idle outside
    // of process() and the plugin's preset_prepare reads from the pointer.
    const dst = new Uint8Array(this.memory.buffer, this.eventBufPtr, bytes.length);
    dst.set(bytes);
    const handle = this.exports[EXPORTS.preset_prepare]!(this.eventBufPtr, bytes.length);
    if (handle === 0) throw new Error('PluginInstance.preparePreset: noa_preset_prepare returned 0');
    return handle;
  }

  /**
   * Worker-side call: serialize a prepared preset's bytes into the format
   * `setState` accepts. Returns a fresh `Uint8Array` (copied out of plugin
   * memory).
   */
  serializePreset(handle: number): Uint8Array {
    this.assertPresetSupport('serializePreset');
    const size = this.exports[EXPORTS.preset_get_state_size]!(handle);
    if (size === 0) return new Uint8Array(0);
    const written = this.exports[EXPORTS.preset_serialize]!(handle, this.stateScratchPtr);
    return new Uint8Array(new Uint8Array(this.memory.buffer, this.stateScratchPtr, written));
  }

  /** Release a prepared preset. Safe to call with an invalid handle. */
  freePreset(handle: number): void {
    this.assertPresetSupport('freePreset');
    this.exports[EXPORTS.preset_free]!(handle);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.exports[EXPORTS.destroy]();
    this.destroyed = true;
  }
}
