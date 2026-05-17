/// <reference types="@types/audioworklet" />
import { RingBuffer } from './RingBuffer';
import { EVENT_FRAME_SIZE, decodeEvent, type EngineEvent } from './EngineEvent';
import { SineGenerator } from './dsp/SineGenerator';

const METER_FRAME_SIZE = 16;

interface NoaProcessorOptions {
  eventSab: SharedArrayBuffer;
  meterSab: SharedArrayBuffer;
  telemetrySab: SharedArrayBuffer;
}

class NoaEngineProcessor extends AudioWorkletProcessor {
  private readonly eventRing: RingBuffer;
  private readonly meterRing: RingBuffer;
  private readonly telemetry: Uint32Array;
  private readonly generator: SineGenerator;
  private readonly eventFrame = new Uint8Array(EVENT_FRAME_SIZE);
  private readonly meterFrame = new Uint8Array(METER_FRAME_SIZE);
  private readonly meterView = new DataView(this.meterFrame.buffer);
  private sampleCounter = 0;
  private blockCounter = 0;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const p = options.processorOptions as NoaProcessorOptions;
    this.eventRing = new RingBuffer(p.eventSab);
    this.meterRing = new RingBuffer(p.meterSab);
    this.telemetry = new Uint32Array(p.telemetrySab);
    this.generator = new SineGenerator(sampleRate);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const left = output[0];
    const right = output[1];
    const blockSize = left.length;

    // Drain queued events for this block.
    const events: EngineEvent[] = [];
    while (this.eventRing.pop(this.eventFrame)) {
      events.push(decodeEvent(this.eventFrame));
    }

    this.generator.process(events, left);
    if (right) right.set(left);

    // Compute peak & RMS and publish a meter frame.
    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < blockSize; i++) {
      const s = left[i]!;
      const a = s < 0 ? -s : s;
      if (a > peak) peak = a;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / blockSize);
    this.meterView.setUint32(0, 0, true); // channel 0 = master
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
