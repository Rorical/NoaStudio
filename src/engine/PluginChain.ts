import { PluginInstance } from './PluginInstance';
import { EVENT_FRAME_SIZE } from './EngineEvent';

/** Maximum events queued for a single slot in a single block. */
const MAX_EVENTS_PER_SLOT = 256;

interface SlotEventBuffer {
  bytes: Uint8Array;
  count: number;
}

/**
 * Linear signal chain hosted inside the audio worklet.
 *
 *  - slot 0 is conventionally the generator (events targeting `targetId === 0` go here);
 *  - slots 1..N are insert FX, each taking the previous slot's output as input;
 *  - empty slots are skipped;
 *  - the final non-empty slot's output is the chain's output.
 *
 * Multi-channel routing is a Phase 6 deliverable; the worklet drives a single
 * chain for v1.
 */
export class PluginChain {
  private readonly chain: (PluginInstance | null)[] = [];
  /** Stereo interleaved scratch buffer used as the inter-slot audio bus. */
  private readonly bus: Float32Array;
  /** Per-slot accumulated raw EngineEvent frames for the current block. */
  private readonly slotEvents = new Map<number, SlotEventBuffer>();
  readonly maxBlockSize: number;

  constructor(maxBlockSize: number) {
    this.maxBlockSize = maxBlockSize;
    this.bus = new Float32Array(maxBlockSize * 2);
  }

  /** Place an instance at `slot`, growing the chain if needed. */
  install(slot: number, instance: PluginInstance): void {
    if (slot < 0) throw new Error(`PluginChain.install: slot ${slot} must be >= 0`);
    if (instance.maxBlockSize < this.maxBlockSize) {
      throw new Error(
        `PluginChain.install: instance maxBlockSize ${instance.maxBlockSize} ` +
        `< chain maxBlockSize ${this.maxBlockSize}`,
      );
    }
    while (this.chain.length <= slot) this.chain.push(null);
    const prev = this.chain[slot];
    if (prev) prev.destroy();
    this.chain[slot] = instance;
  }

  /** Remove and destroy the instance at `slot`. No-op if the slot is empty. */
  uninstall(slot: number): void {
    const inst = this.chain[slot];
    if (!inst) return;
    inst.destroy();
    this.chain[slot] = null;
    this.slotEvents.delete(slot);
  }

  /** Retrieve the instance at `slot`, or null. */
  get(slot: number): PluginInstance | null {
    return this.chain[slot] ?? null;
  }

  /** Iterate occupied slots in slot order. */
  occupiedSlots(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.chain.length; i++) {
      if (this.chain[i]) out.push(i);
    }
    return out;
  }

  /**
   * Queue a raw EngineEvent frame for an instance addressed by slot. The frame
   * must be a 32-byte buffer; bytes are copied. Frames beyond MAX_EVENTS_PER_SLOT
   * for a given slot in a single block are silently dropped (capacity is huge
   * for Phase 3 and overflow indicates a bug elsewhere).
   */
  queueEventFrame(slot: number, frame: Uint8Array): void {
    if (frame.length !== EVENT_FRAME_SIZE) {
      throw new Error(`PluginChain.queueEventFrame: expected ${EVENT_FRAME_SIZE} bytes, got ${frame.length}`);
    }
    let entry = this.slotEvents.get(slot);
    if (!entry) {
      entry = { bytes: new Uint8Array(MAX_EVENTS_PER_SLOT * EVENT_FRAME_SIZE), count: 0 };
      this.slotEvents.set(slot, entry);
    }
    if (entry.count >= MAX_EVENTS_PER_SLOT) return;
    entry.bytes.set(frame, entry.count * EVENT_FRAME_SIZE);
    entry.count++;
  }

  /**
   * Process one audio block. Walks all occupied slots in order:
   *   - drains each instance's per-instance param ring (UI knob updates);
   *   - copies any queued global-ring events into the plugin's event buffer;
   *   - writes upstream output as input for FX slots; skips input for generators;
   *   - calls noa_process;
   *   - reads output back into the bus.
   *
   * Writes the chain's final output (interleaved stereo) into `outBus`.
   * `outBus.length` must equal `blockSize * 2`. When the chain has no occupied
   * slots, `outBus` is zeroed.
   */
  processBlock(blockSize: number, outBus: Float32Array): void {
    if (blockSize > this.maxBlockSize) {
      throw new Error(`PluginChain.processBlock: blockSize ${blockSize} > maxBlockSize ${this.maxBlockSize}`);
    }
    if (outBus.length !== blockSize * 2) {
      throw new Error(`PluginChain.processBlock: outBus must be ${blockSize * 2} samples (got ${outBus.length})`);
    }

    // Reset bus to silence; subsequent slots overwrite it.
    this.bus.fill(0, 0, blockSize * 2);

    let hadAnySlot = false;
    let firstSlot = true;

    for (let slot = 0; slot < this.chain.length; slot++) {
      const inst = this.chain[slot];
      if (!inst) continue;
      hadAnySlot = true;

      inst.drainParamRing();

      const entry = this.slotEvents.get(slot);
      const nEvents = entry ? entry.count : 0;
      if (entry && nEvents > 0) {
        inst.pushEvents(entry.bytes, nEvents);
        entry.count = 0;
      }

      // FX slots take upstream output as input; generators ignore input.
      if (!firstSlot && inst.manifest.kind === 'fx') {
        inst.writeInput(this.bus.subarray(0, blockSize * 2));
      }

      inst.process(blockSize, nEvents);
      inst.readOutput(this.bus.subarray(0, blockSize * 2));
      firstSlot = false;
    }

    if (hadAnySlot) {
      outBus.set(this.bus.subarray(0, blockSize * 2));
    } else {
      outBus.fill(0, 0, blockSize * 2);
    }

    // Any leftover queued events at slots without a current instance:
    // discard so they don't accumulate across blocks.
    for (const [slot, entry] of this.slotEvents) {
      if (!this.chain[slot]) entry.count = 0;
    }
  }

  /** Destroy every instance. */
  dispose(): void {
    for (let i = 0; i < this.chain.length; i++) {
      const inst = this.chain[i];
      if (inst) inst.destroy();
      this.chain[i] = null;
    }
    this.slotEvents.clear();
  }
}
