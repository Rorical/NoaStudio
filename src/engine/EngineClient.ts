import { allocRingBuffer, RingBuffer } from './RingBuffer';
import {
  EVENT_FRAME_SIZE,
  encodeEvent,
  EVT_NOTE_ON, EVT_NOTE_OFF, EVT_TEMPO, EVT_TRANSPORT,
  TRANSPORT_PLAY, TRANSPORT_STOP,
  type EngineEvent,
} from './EngineEvent';

const METER_FRAME_SIZE = 16;
const EVENT_RING_SLOTS = 1024;
const METER_RING_SLOTS = 256;

export interface MeterReading {
  channelId: number;
  peak: number;
  rms: number;
  blockCounter: number;
}

export class EngineClient {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private eventRing: RingBuffer | null = null;
  private meterRing: RingBuffer | null = null;
  private telemetry: Uint32Array | null = null;
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
    const telemetrySab = new SharedArrayBuffer(4);

    this.eventRing = new RingBuffer(eventLayout.sab);
    this.meterRing = new RingBuffer(meterLayout.sab);
    this.telemetry = new Uint32Array(telemetrySab);

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
  }

  /** AudioContext starts suspended in most browsers; call from a user gesture. */
  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
  }

  get sampleRate(): number {
    if (!this.ctx) throw new Error('EngineClient not initialized');
    return this.ctx.sampleRate;
  }

  sendEvent(ev: EngineEvent): boolean {
    if (!this.eventRing) throw new Error('EngineClient not initialized');
    encodeEvent(ev, this.eventFrame);
    return this.eventRing.push(this.eventFrame);
  }

  noteOn(note: number, velocity = 100): void {
    this.sendEvent({
      type: EVT_NOTE_ON, frameOffset: 0, targetId: 0, note, velocity, channel: 0,
    });
  }

  noteOff(note: number): void {
    this.sendEvent({
      type: EVT_NOTE_OFF, frameOffset: 0, targetId: 0, note, channel: 0,
    });
  }

  play(positionBeats = 0): void {
    this.sendEvent({
      type: EVT_TRANSPORT, frameOffset: 0, command: TRANSPORT_PLAY, positionBeats,
    });
  }

  stop(): void {
    this.sendEvent({
      type: EVT_TRANSPORT, frameOffset: 0, command: TRANSPORT_STOP, positionBeats: 0,
    });
  }

  setTempo(bpm: number): void {
    this.sendEvent({ type: EVT_TEMPO, frameOffset: 0, bpm });
  }

  /** Drains every queued meter frame into `out`. */
  readMeters(out: MeterReading[]): void {
    if (!this.meterRing) return;
    out.length = 0;
    while (this.meterRing.pop(this.meterFrame)) {
      out.push({
        channelId: this.meterView.getUint32(0, true),
        peak: this.meterView.getFloat32(4, true),
        rms: this.meterView.getFloat32(8, true),
        blockCounter: this.meterView.getUint32(12, true),
      });
    }
  }

  /** Worklet's sample counter, low 32 bits. Wraps after ~24h at 48k — fine for Phase 1 UI. */
  currentSamplePosition(): number {
    return this.telemetry ? Atomics.load(this.telemetry, 0) : 0;
  }

  async dispose(): Promise<void> {
    this.node?.disconnect();
    this.node = null;
    await this.ctx?.close();
    this.ctx = null;
    this.eventRing = null;
    this.meterRing = null;
    this.telemetry = null;
  }
}
