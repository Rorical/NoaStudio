/// <reference types="@types/audioworklet" />
import { RingBuffer } from './RingBuffer';
import {
  EVENT_FRAME_SIZE,
  rewriteFrameOffset,
  EVT_NOTE_ON, EVT_NOTE_OFF, EVT_PARAM_SET, EVT_TRANSPORT, EVT_TEMPO,
  TRANSPORT_PLAY, TRANSPORT_STOP, TRANSPORT_PAUSE,
} from './EngineEvent';
import { PluginInstance } from './PluginInstance';
import { PluginChain } from './PluginChain';
import { MixerRouter, type RoutingConfig } from './MixerRouter';
import { channelHash } from './channelHash';
import type { PluginManifest } from './PluginManifest';

const METER_FRAME_SIZE = 16;
/**
 * AudioWorklet render quantum is currently fixed at 128 frames in Chromium.
 * Plugin instances allocate buffers sized to this value.
 */
const MAX_WORKLET_BLOCK = 128;
/**
 * Soft cap on the pending-event queue. Phase 6a's ClipScheduler looks ahead
 * ~50 ms; at 48 kHz that's a couple thousand samples and ~50 notes worst case,
 * comfortably below this bound.
 */
const MAX_PENDING_EVENTS = 4096;

interface NoaProcessorOptions {
  eventSab: SharedArrayBuffer;
  meterSab: SharedArrayBuffer;
  telemetrySab: SharedArrayBuffer;
}

interface InstantiateMessage {
  type: 'INSTANTIATE_PLUGIN';
  instanceId: string;
  numericId: number;
  chainId: string;
  slot: number;
  /**
   * Raw WASM bytes. WebAssembly.Module instances are not structured-cloneable
   * to AudioWorkletGlobalScope (crbug.com/1078182), so the main thread sends
   * bytes and the worklet compiles synchronously via `new WebAssembly.Module`.
   */
  wasm: Uint8Array;
  manifest: PluginManifest;
  initialParams?: number[];
}

interface DestroyMessage {
  type: 'DESTROY_INSTANCE';
  numericId: number;
  chainId: string;
  slot: number;
}

interface ApplyPresetStateMessage {
  type: 'APPLY_PRESET_STATE';
  chainId: string;
  slot: number;
  stateBytes: Uint8Array;
}

interface UpdateRoutingMessage {
  type: 'UPDATE_ROUTING';
  config: RoutingConfig;
}

interface SetLoopMessage {
  type: 'SET_LOOP';
  enabled: boolean;
  startBeats: number;
  endBeats: number;
  bpm: number;
  sampleRate: number;
}

type WorkletInbound =
  | InstantiateMessage
  | DestroyMessage
  | ApplyPresetStateMessage
  | UpdateRoutingMessage
  | SetLoopMessage;

interface PendingEvent {
  sampleTime: number;
  frame: Uint8Array;
}

class NoaEngineProcessor extends AudioWorkletProcessor {
  private readonly eventRing: RingBuffer;
  private readonly meterRing: RingBuffer;
  private readonly telemetry: Uint32Array;
  private readonly telemetryF32: Float32Array;
  private readonly router = new MixerRouter(MAX_WORKLET_BLOCK);
  private readonly outBus = new Float32Array(MAX_WORKLET_BLOCK * 2);
  private readonly eventFrame = new Uint8Array(EVENT_FRAME_SIZE);
  private readonly eventFrameView: DataView;
  private readonly meterFrame = new Uint8Array(METER_FRAME_SIZE);
  private readonly meterView = new DataView(this.meterFrame.buffer);
  /** Re-used pool of frame buffers for the pending-event queue. */
  private readonly framePool: Uint8Array[] = [];
  /** Events scheduled in the future, sorted by sampleTime each block. */
  private pending: PendingEvent[] = [];
  /** Map of chainId → PluginChain so instances can grow chains incrementally. */
  private readonly pluginChains = new Map<string, PluginChain>();
  private sampleCounter = 0;
  private blockCounter = 0;

  /** Transport state owned by the worklet (Phase 6b). */
  private transportPlaying = false;
  /** Playhead in samples — distinct from `sampleCounter` (audio-block tick). */
  private playheadSamples = 0;
  private bpm = 120;
  private loopEnabled = false;
  private loopStartSamples = 0;
  private loopEndSamples = 0;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const p = options.processorOptions as NoaProcessorOptions;
    this.eventRing = new RingBuffer(p.eventSab);
    this.meterRing = new RingBuffer(p.meterSab);
    this.telemetry = new Uint32Array(p.telemetrySab);
    this.telemetryF32 = new Float32Array(p.telemetrySab);
    this.eventFrameView = new DataView(
      this.eventFrame.buffer,
      this.eventFrame.byteOffset,
      EVENT_FRAME_SIZE,
    );

    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as WorkletInbound;
      switch (m.type) {
        case 'INSTANTIATE_PLUGIN':
          this.handleInstantiate(m);
          break;
        case 'DESTROY_INSTANCE':
          this.handleDestroy(m);
          break;
        case 'APPLY_PRESET_STATE':
          this.handleApplyPresetState(m);
          break;
        case 'UPDATE_ROUTING':
          this.router.updateRouting(m.config);
          break;
        case 'SET_LOOP':
          this.handleSetLoop(m);
          break;
      }
    };
  }

  private handleSetLoop(m: SetLoopMessage): void {
    this.loopEnabled = m.enabled;
    this.bpm = m.bpm;
    const samplesPerBeat = (m.sampleRate * 60) / m.bpm;
    this.loopStartSamples = Math.round(m.startBeats * samplesPerBeat);
    this.loopEndSamples = Math.round(m.endBeats * samplesPerBeat);
  }

  private getOrCreateChain(chainId: string): PluginChain {
    let chain = this.pluginChains.get(chainId);
    if (!chain) {
      chain = new PluginChain(MAX_WORKLET_BLOCK);
      this.pluginChains.set(chainId, chain);
      this.router.installChain(chainId, chain);
    }
    return chain;
  }

  private handleInstantiate(m: InstantiateMessage): void {
    try {
      // Cast through `BufferSource` because TS 5.7's stricter typing narrows
      // Uint8Array<ArrayBufferLike> away from the WebAssembly.Module sig.
      const module = new WebAssembly.Module(m.wasm as unknown as BufferSource);
      const inst = PluginInstance.fromModule(module, m.manifest, {
        sampleRate,
        maxBlockSize: MAX_WORKLET_BLOCK,
        allocateRings: true,
        ...(m.initialParams ? { initialParams: m.initialParams } : {}),
      });
      const chain = this.getOrCreateChain(m.chainId);
      chain.install(m.slot, inst);
      this.router.registerInstance(m.numericId, m.chainId, m.slot);
      this.port.postMessage({
        type: 'INSTANCE_READY',
        instanceId: m.instanceId,
        numericId: m.numericId,
        chainId: m.chainId,
        slot: m.slot,
        paramRingSab: inst.paramRingSab,
        notifyRingSab: inst.notifyRingSab,
      });
    } catch (err) {
      this.port.postMessage({
        type: 'INSTANCE_ERROR',
        instanceId: m.instanceId,
        error: String((err as Error)?.message ?? err),
      });
    }
  }

  private handleDestroy(m: DestroyMessage): void {
    const chain = this.pluginChains.get(m.chainId);
    if (chain) chain.uninstall(m.slot);
    this.router.unregisterInstance(m.numericId);
  }

  private handleApplyPresetState(m: ApplyPresetStateMessage): void {
    const chain = this.pluginChains.get(m.chainId);
    const inst = chain?.get(m.slot);
    if (!inst) return;
    inst.setState(m.stateBytes);
    const paramCount = inst.manifest.params.length;
    for (let i = 0; i < paramCount; i++) {
      inst.pushNotifyParamChanged(i, inst.readParam(i), this.blockCounter);
    }
  }

  private acquireFrame(): Uint8Array {
    return this.framePool.pop() ?? new Uint8Array(EVENT_FRAME_SIZE);
  }

  private releaseFrame(f: Uint8Array): void {
    this.framePool.push(f);
  }

  /**
   * Drain the engine event ring into the pending queue, copying frame bytes
   * because the ring's read buffer is shared and gets overwritten.
   */
  private drainRing(): void {
    while (this.eventRing.pop(this.eventFrame)) {
      if (this.pending.length >= MAX_PENDING_EVENTS) break;
      const sampleTime = this.eventFrameView.getUint32(4, true);
      const f = this.acquireFrame();
      f.set(this.eventFrame);
      this.pending.push({ sampleTime, frame: f });
    }
  }

  /**
   * Dispatch every event whose sampleTime falls in the current block. Frames
   * scheduled in the past (sampleTime ≤ blockStart) fire at frameOffset 0;
   * frames in the future stay pending. Frames with sampleTime === 0 act as
   * "fire immediately" and dispatch on the next process() call. Transport /
   * Tempo events update the worklet's internal transport state rather than
   * routing through to a plugin.
   */
  private dispatchPending(blockStart: number, blockEnd: number): void {
    if (this.pending.length === 0) return;
    this.pending.sort((a, b) => a.sampleTime - b.sampleTime);

    let i = 0;
    while (i < this.pending.length) {
      const ev = this.pending[i]!;
      if (ev.sampleTime >= blockEnd && ev.sampleTime !== 0) break;
      const view = new DataView(ev.frame.buffer, ev.frame.byteOffset, EVENT_FRAME_SIZE);
      const type = view.getUint8(0);
      if (type === EVT_TRANSPORT) {
        const command = view.getUint8(8);
        const positionBeats = view.getFloat64(16, true);
        this.applyTransport(command, positionBeats);
      } else if (type === EVT_TEMPO) {
        this.bpm = view.getFloat32(8, true);
      } else if (type === EVT_NOTE_ON || type === EVT_NOTE_OFF || type === EVT_PARAM_SET) {
        const frameOffset = ev.sampleTime <= blockStart ? 0 : ev.sampleTime - blockStart;
        rewriteFrameOffset(ev.frame, frameOffset);
        const targetId = view.getUint32(8, true);
        this.router.queueEvent(targetId, ev.frame);
      }
      this.releaseFrame(ev.frame);
      i++;
    }
    if (i > 0) this.pending.splice(0, i);
  }

  private applyTransport(command: number, positionBeats: number): void {
    if (command === TRANSPORT_PLAY) {
      this.transportPlaying = true;
      const samplesPerBeat = (sampleRate * 60) / this.bpm;
      this.playheadSamples = Math.round(positionBeats * samplesPerBeat);
    } else if (command === TRANSPORT_STOP) {
      this.transportPlaying = false;
      this.playheadSamples = 0;
    } else if (command === TRANSPORT_PAUSE) {
      this.transportPlaying = false;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const left = output[0];
    const right = output[1];
    const blockSize = left.length;
    const blockStart = this.sampleCounter;
    const blockEnd = blockStart + blockSize;

    this.drainRing();
    this.dispatchPending(blockStart, blockEnd);

    const outStereo = this.outBus.subarray(0, blockSize * 2);
    const meters = this.router.processBlock(blockSize, outStereo);

    for (let i = 0; i < blockSize; i++) {
      left[i] = outStereo[i * 2]!;
      if (right) right[i] = outStereo[i * 2 + 1]!;
    }

    for (let i = 0; i < meters.length; i++) {
      const m = meters[i]!;
      this.meterView.setUint32(0, channelHash(m.channelId), true);
      this.meterView.setFloat32(4, m.peak, true);
      this.meterView.setFloat32(8, m.rms, true);
      this.meterView.setUint32(12, this.blockCounter, true);
      this.meterRing.push(this.meterFrame);
    }

    this.sampleCounter += blockSize;
    if (this.transportPlaying) {
      this.playheadSamples += blockSize;
      if (this.loopEnabled
          && this.loopEndSamples > this.loopStartSamples
          && this.playheadSamples >= this.loopEndSamples) {
        const overshoot = this.playheadSamples - this.loopEndSamples;
        const loopLen = this.loopEndSamples - this.loopStartSamples;
        this.playheadSamples = this.loopStartSamples + (overshoot % loopLen);
      }
    }
    Atomics.store(this.telemetry, 0, this.playheadSamples >>> 0);
    const samplesPerBeat = (sampleRate * 60) / this.bpm;
    this.telemetryF32[1] = this.playheadSamples / samplesPerBeat;
    Atomics.store(this.telemetry, 2, this.transportPlaying ? 1 : 0);
    Atomics.store(this.telemetry, 3, this.blockCounter);
    this.blockCounter++;
    return true;
  }
}

registerProcessor('noa-engine', NoaEngineProcessor);
