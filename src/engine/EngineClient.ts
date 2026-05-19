import { allocRingBuffer, RingBuffer } from './RingBuffer';
import {
  EVENT_FRAME_SIZE,
  encodeEvent,
  EVT_NOTE_ON, EVT_NOTE_OFF, EVT_PARAM_SET, EVT_TEMPO, EVT_TRANSPORT,
  TRANSPORT_PLAY, TRANSPORT_STOP,
  type EngineEvent,
} from './EngineEvent';
import {
  WorkletProtocol,
  type LoadPluginResult,
} from './WorkletProtocol';
import { PluginWorker, type PreparedPreset } from './PluginWorker';
import type { PluginManifest } from './PluginManifest';
import type { RoutingConfig } from './MixerRouter';

/**
 * EngineClient's loadPlugin args. Smaller than the WorkletProtocol's because
 * the numeric event-target id is minted inside EngineClient — callers don't
 * have to thread one through.
 */
export interface EngineLoadPluginArgs {
  instanceId: string;
  chainId: string;
  slot: number;
  wasm: Uint8Array;
  manifest: PluginManifest;
  initialParams?: number[];
}

const METER_FRAME_SIZE = 16;
const EVENT_RING_SLOTS = 1024;
const METER_RING_SLOTS = 256;
/** Per-instance worker matches the worklet's render quantum so allocations align. */
const WORKER_MAX_BLOCK_SIZE = 128;
/**
 * Telemetry SAB layout — four 32-bit words:
 *   [0] u32 — playheadSamples (low 32 bits)
 *   [1] f32 — playheadBeats (float32 reinterpret)
 *   [2] u32 — flags (bit 0 = playing)
 *   [3] u32 — blockCounter
 */
const TELEMETRY_BYTES = 16;
const TELEMETRY_PLAYING_BIT = 1;

interface InstanceMeta {
  numericId: number;
  chainId: string;
  slot: number;
  worker: Worker;
  pluginWorker: PluginWorker;
}

export interface MeterReading {
  /** FNV-1a 32-bit hash of the channel id string. Use channelHash(id) on the
   *  main thread to look up which channel this frame belongs to. */
  channelHash: number;
  peak: number;
  rms: number;
  blockCounter: number;
}

export class EngineClient {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private protocol: WorkletProtocol | null = null;
  private eventRing: RingBuffer | null = null;
  private meterRing: RingBuffer | null = null;
  private telemetry: Uint32Array | null = null;
  private telemetryF32: Float32Array | null = null;
  private readonly instances = new Map<string, InstanceMeta>();
  /** Monotonic counter for EngineEvent.targetId. */
  private nextNumericId = 1;
  /** Last tempo posted via setTempo — needed so setLoop can resolve sample
   *  positions worklet-side. */
  private currentBpm = 120;
  private readonly eventFrame = new Uint8Array(EVENT_FRAME_SIZE);
  private readonly meterFrame = new Uint8Array(METER_FRAME_SIZE);
  private readonly meterView = new DataView(this.meterFrame.buffer);

  async init(workletUrl: string | URL): Promise<void> {
    if (typeof crossOriginIsolated !== 'undefined' && !crossOriginIsolated) {
      throw new Error(
        'EngineClient requires crossOriginIsolated; check COOP/COEP headers in vite.config.js',
      );
    }
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule(workletUrl);

    const eventLayout = allocRingBuffer(EVENT_RING_SLOTS, EVENT_FRAME_SIZE);
    const meterLayout = allocRingBuffer(METER_RING_SLOTS, METER_FRAME_SIZE);
    const telemetrySab = new SharedArrayBuffer(TELEMETRY_BYTES);

    this.eventRing = new RingBuffer(eventLayout.sab);
    this.meterRing = new RingBuffer(meterLayout.sab);
    this.telemetry = new Uint32Array(telemetrySab);
    this.telemetryF32 = new Float32Array(telemetrySab);

    this.node = new AudioWorkletNode(this.ctx, 'noa-engine', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        eventSab: eventLayout.sab,
        meterSab: meterLayout.sab,
        telemetrySab,
      },
    });
    this.node.connect(this.ctx.destination);
    this.protocol = new WorkletProtocol(this.node.port);
  }

  /** AudioContext starts suspended in most browsers; call from a user gesture. */
  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
  }

  get sampleRate(): number {
    if (!this.ctx) throw new Error('EngineClient not initialized');
    return this.ctx.sampleRate;
  }

  /**
   * Push an already-encoded 32-byte EngineEvent frame onto the ring. Used by
   * the ClipScheduler where the caller already has the bytes laid out.
   * Returns false on ring overflow.
   */
  pushEventFrame(frame: Uint8Array): boolean {
    if (!this.eventRing) throw new Error('EngineClient not initialized');
    return this.eventRing.push(frame);
  }

  sendEvent(ev: EngineEvent): boolean {
    if (!this.eventRing) throw new Error('EngineClient not initialized');
    encodeEvent(ev, this.eventFrame);
    return this.eventRing.push(this.eventFrame);
  }

  /** Route a NoteOn to the instance occupying the given slot (default slot 0 = generator). */
  noteOn(note: number, velocity = 100, slot = 0): void {
    this.sendEvent({
      type: EVT_NOTE_ON, sampleTime: 0, targetId: slot, note, velocity, channel: 0,
    });
  }

  noteOff(note: number, slot = 0): void {
    this.sendEvent({
      type: EVT_NOTE_OFF, sampleTime: 0, targetId: slot, note, channel: 0,
    });
  }

  /**
   * Push a ParamSet event to the instance identified by `instanceId`. Block-
   * rate; use the per-instance param ring (handed back from `loadPlugin`) for
   * sample-accurate UI knob updates. No-op if the instance is unknown.
   */
  setParam(instanceId: string, paramIndex: number, value: number): void {
    const meta = this.instances.get(instanceId);
    if (!meta) return;
    this.sendEvent({
      type: EVT_PARAM_SET, sampleTime: 0, targetId: meta.numericId, paramIndex, value,
    });
  }

  play(positionBeats = 0): void {
    this.sendEvent({
      type: EVT_TRANSPORT, sampleTime: 0, command: TRANSPORT_PLAY, positionBeats,
    });
  }

  stop(): void {
    this.sendEvent({
      type: EVT_TRANSPORT, sampleTime: 0, command: TRANSPORT_STOP, positionBeats: 0,
    });
  }

  setTempo(bpm: number): void {
    this.currentBpm = bpm;
    this.sendEvent({ type: EVT_TEMPO, sampleTime: 0, bpm });
  }

  /**
   * Instantiate a plugin inside the worklet at the given slot AND spawn a
   * per-instance plugin worker. Resolves with the per-instance SAB rings
   * (returned by the worklet) once both sides have signalled ready.
   */
  async loadPlugin(args: EngineLoadPluginArgs): Promise<LoadPluginResult> {
    if (!this.protocol) throw new Error('EngineClient not initialized');
    const numericId = this.nextNumericId++;
    const result = await this.protocol.loadPlugin({ ...args, numericId });

    // Spawn the non-RT worker. Vite resolves the URL at build time; in dev
    // mode it's served from the source tree.
    const worker = new Worker(
      new URL('./plugin-host.worker.ts', import.meta.url),
      { type: 'module' },
    );
    const pluginWorker = new PluginWorker(worker);

    // Promise-shaped wrapper around the worker's error events so a worker
    // that fails to load (URL/module/import error) doesn't leave loadPlugin
    // awaiting READY forever. Whichever resolves first wins.
    const errorPromise = new Promise<never>((_, reject) => {
      worker.onerror = (e) => {
        const reason = (e instanceof ErrorEvent && e.message) ? e.message : 'unknown worker error';
        reject(new Error(`plugin-host.worker errored: ${reason}`));
      };
      worker.onmessageerror = () => reject(new Error('plugin-host.worker message decoding error'));
    });

    try {
      await Promise.race([
        pluginWorker.spawn({
          instanceId: args.instanceId,
          wasm: args.wasm,
          manifest: args.manifest,
          sampleRate: this.sampleRate,
          maxBlockSize: WORKER_MAX_BLOCK_SIZE,
        }),
        errorPromise,
      ]);
    } catch (err) {
      pluginWorker.dispose();
      worker.terminate();
      // Worklet side is already up; tear it down to keep the chain consistent.
      this.protocol.unloadInstance({
        numericId: result.numericId,
        chainId: result.chainId,
        slot: result.slot,
      });
      throw err;
    }

    this.instances.set(args.instanceId, {
      numericId: result.numericId,
      chainId: result.chainId,
      slot: result.slot,
      worker,
      pluginWorker,
    });
    return result;
  }

  /** Update the worklet's routing topology. Fire-and-forget. */
  updateRouting(config: RoutingConfig): void {
    this.protocol?.updateRouting(config);
  }

  /** Configure the worklet's loop region. */
  setLoop(args: { enabled: boolean; startBeats: number; endBeats: number }): void {
    if (!this.ctx) return;
    this.protocol?.setLoop({ ...args, bpm: this.currentBpm, sampleRate: this.ctx.sampleRate });
  }

  /** Set/clear bypass on the slot occupied by `instanceId`. */
  setBypass(instanceId: string, bypass: boolean): void {
    const meta = this.instances.get(instanceId);
    if (!meta) return;
    this.protocol?.setBypass({ chainId: meta.chainId, slot: meta.slot, bypass });
  }

  /** Look up the engine-side numeric id used as `targetId` for events. */
  getNumericId(instanceId: string): number | undefined {
    return this.instances.get(instanceId)?.numericId;
  }

  /**
   * Fully unload a plugin instance: tear down its worker, drop the worklet
   * slot. Unknown ids are no-ops.
   */
  unloadInstance(instanceId: string): void {
    const meta = this.instances.get(instanceId);
    if (!meta) return;
    meta.pluginWorker.dispose();
    meta.worker.terminate();
    this.protocol?.unloadInstance({
      numericId: meta.numericId,
      chainId: meta.chainId,
      slot: meta.slot,
    });
    this.instances.delete(instanceId);
  }

  /**
   * Prepare a preset on the per-instance worker (slow path). Resolves with
   * a `{handle, stateBytes}` pair. Pass the stateBytes to `activatePreset`
   * to swap the worklet's instance to the new state without glitching audio.
   */
  preparePreset(args: { instanceId: string; bytes: Uint8Array }): Promise<PreparedPreset> {
    const meta = this.instances.get(args.instanceId);
    if (!meta) return Promise.reject(new Error(`EngineClient.preparePreset: unknown instance '${args.instanceId}'`));
    return meta.pluginWorker.preparePreset(args.bytes);
  }

  /**
   * Apply a prepared preset's state to the worklet's instance. Fast — runs
   * inside the worklet's onmessage handler.
   */
  activatePreset(args: { instanceId: string; preparedStateBytes: Uint8Array }): void {
    const meta = this.instances.get(args.instanceId);
    if (!meta) throw new Error(`EngineClient.activatePreset: unknown instance '${args.instanceId}'`);
    this.protocol?.applyPresetState({
      chainId: meta.chainId,
      slot: meta.slot,
      stateBytes: args.preparedStateBytes,
    });
  }

  /** Release a prepared preset handle. The worker frees its slot. */
  freePreset(args: { instanceId: string; handle: number }): void {
    const meta = this.instances.get(args.instanceId);
    if (!meta) return;
    meta.pluginWorker.freePreset(args.handle);
  }

  /** Drains every queued meter frame into `out`. */
  readMeters(out: MeterReading[]): void {
    if (!this.meterRing) return;
    out.length = 0;
    while (this.meterRing.pop(this.meterFrame)) {
      out.push({
        channelHash: this.meterView.getUint32(0, true),
        peak: this.meterView.getFloat32(4, true),
        rms: this.meterView.getFloat32(8, true),
        blockCounter: this.meterView.getUint32(12, true),
      });
    }
  }

  /** Worklet's sample counter, low 32 bits. Wraps after ~24h at 48k. */
  currentSamplePosition(): number {
    return this.telemetry ? Atomics.load(this.telemetry, 0) >>> 0 : 0;
  }

  /**
   * Play a brief metronome-style click directly on the AudioContext's
   * destination — bypasses the worklet's MixerRouter so the click never
   * lands on the master signal that's headed to recording. No-op when the
   * context isn't initialized or is suspended.
   */
  playClick(frequency = 1000, duration = 0.05): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = frequency;
    osc.connect(gain).connect(ctx.destination);
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.15, now + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.start(now);
    osc.stop(now + duration + 0.01);
  }

  /** Worklet-published playhead in beats. Driven by the transport state. */
  playheadBeats(): number {
    return this.telemetryF32 ? this.telemetryF32[1]! : 0;
  }

  /** Whether the worklet's transport is currently playing. */
  isPlaying(): boolean {
    if (!this.telemetry) return false;
    return (Atomics.load(this.telemetry, 2) & TELEMETRY_PLAYING_BIT) !== 0;
  }

  async dispose(): Promise<void> {
    for (const meta of this.instances.values()) {
      meta.pluginWorker.dispose();
      meta.worker.terminate();
    }
    this.instances.clear();
    this.protocol?.dispose();
    this.protocol = null;
    this.node?.disconnect();
    this.node = null;
    await this.ctx?.close();
    this.ctx = null;
    this.eventRing = null;
    this.meterRing = null;
    this.telemetry = null;
    this.telemetryF32 = null;
  }
}

export type { LoadPluginResult };
export type { PreparedPreset };
export type { PluginManifest };
export type { RoutingConfig };
