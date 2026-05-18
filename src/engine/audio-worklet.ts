/// <reference types="@types/audioworklet" />
import { RingBuffer } from './RingBuffer';
import {
  EVENT_FRAME_SIZE,
  decodeEvent,
  EVT_NOTE_ON, EVT_NOTE_OFF, EVT_PARAM_SET,
} from './EngineEvent';
import { PluginInstance } from './PluginInstance';
import { PluginChain } from './PluginChain';
import type { PluginManifest } from './PluginManifest';

const METER_FRAME_SIZE = 16;
/**
 * AudioWorklet render quantum is currently fixed at 128 frames in Chromium.
 * Plugin instances allocate buffers sized to this value.
 */
const MAX_WORKLET_BLOCK = 128;

interface NoaProcessorOptions {
  eventSab: SharedArrayBuffer;
  meterSab: SharedArrayBuffer;
  telemetrySab: SharedArrayBuffer;
}

interface InstantiateMessage {
  type: 'INSTANTIATE_PLUGIN';
  instanceId: string;
  slot: number;
  module: WebAssembly.Module;
  manifest: PluginManifest;
  initialParams?: number[];
}

interface DestroyMessage {
  type: 'DESTROY_INSTANCE';
  slot: number;
}

type WorkletInbound = InstantiateMessage | DestroyMessage;

class NoaEngineProcessor extends AudioWorkletProcessor {
  private readonly eventRing: RingBuffer;
  private readonly meterRing: RingBuffer;
  private readonly telemetry: Uint32Array;
  private readonly chain = new PluginChain(MAX_WORKLET_BLOCK);
  private readonly outBus = new Float32Array(MAX_WORKLET_BLOCK * 2);
  private readonly eventFrame = new Uint8Array(EVENT_FRAME_SIZE);
  private readonly meterFrame = new Uint8Array(METER_FRAME_SIZE);
  private readonly meterView = new DataView(this.meterFrame.buffer);
  private readonly pendingMessages: WorkletInbound[] = [];
  private sampleCounter = 0;
  private blockCounter = 0;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const p = options.processorOptions as NoaProcessorOptions;
    this.eventRing = new RingBuffer(p.eventSab);
    this.meterRing = new RingBuffer(p.meterSab);
    this.telemetry = new Uint32Array(p.telemetrySab);
    this.port.onmessage = (e: MessageEvent) => {
      this.pendingMessages.push(e.data as WorkletInbound);
    };
  }

  private applyPending(): void {
    while (this.pendingMessages.length > 0) {
      const m = this.pendingMessages.shift()!;
      switch (m.type) {
        case 'INSTANTIATE_PLUGIN':
          this.handleInstantiate(m);
          break;
        case 'DESTROY_INSTANCE':
          this.chain.uninstall(m.slot);
          break;
      }
    }
  }

  private handleInstantiate(m: InstantiateMessage): void {
    try {
      const inst = PluginInstance.fromModule(m.module, m.manifest, {
        sampleRate,
        maxBlockSize: MAX_WORKLET_BLOCK,
        allocateRings: true,
        ...(m.initialParams ? { initialParams: m.initialParams } : {}),
      });
      this.chain.install(m.slot, inst);
      this.port.postMessage({
        type: 'INSTANCE_READY',
        instanceId: m.instanceId,
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

  private drainEventsIntoChain(): void {
    while (this.eventRing.pop(this.eventFrame)) {
      // Only route per-instance event types by targetId. Other types
      // (Transport, Tempo) are ignored here for Phase 3.
      const ev = decodeEvent(this.eventFrame);
      if (ev.type === EVT_NOTE_ON || ev.type === EVT_NOTE_OFF || ev.type === EVT_PARAM_SET) {
        this.chain.queueEventFrame(ev.targetId, this.eventFrame);
      }
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    this.applyPending();

    const output = outputs[0];
    if (!output || !output[0]) return true;
    const left = output[0];
    const right = output[1];
    const blockSize = left.length;

    this.drainEventsIntoChain();
    this.chain.processBlock(blockSize, this.outBus.subarray(0, blockSize * 2));

    // Deinterleave the stereo bus into the worklet's separate channels and
    // compute peak / RMS as we go.
    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < blockSize; i++) {
      const l = this.outBus[i * 2]!;
      const r = this.outBus[i * 2 + 1]!;
      left[i] = l;
      if (right) right[i] = r;
      const mono = (l + r) * 0.5;
      const a = mono < 0 ? -mono : mono;
      if (a > peak) peak = a;
      sumSq += mono * mono;
    }
    const rms = Math.sqrt(sumSq / blockSize);

    // Publish master meter (channel 0).
    this.meterView.setUint32(0, 0, true);
    this.meterView.setFloat32(4, peak, true);
    this.meterView.setFloat32(8, rms, true);
    this.meterView.setUint32(12, this.blockCounter, true);
    this.meterRing.push(this.meterFrame);

    // Advance counters and publish telemetry (sample-count low 32 bits).
    this.sampleCounter += blockSize;
    Atomics.store(this.telemetry, 0, this.sampleCounter >>> 0);
    this.blockCounter++;

    return true;
  }
}

registerProcessor('noa-engine', NoaEngineProcessor);
