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
  /** Per-slot bypass flag — true means the slot is silent and audio passes
   *  straight through to the next slot. */
  private readonly bypass = new Map<number, boolean>();
  readonly maxBlockSize: number;

  constructor(maxBlockSize: number) {
    this.maxBlockSize = maxBlockSize;
    this.bus = new Float32Array(maxBlockSize * 2);
  }

  /** Set/clear the bypass flag for a slot. No-op for empty slots. */
  setBypass(slot: number, bypass: boolean): void {
    if (bypass) this.bypass.set(slot, true);
    else this.bypass.delete(slot);
  }

  /** Whether the given slot is currently bypassed. */
  isBypassed(slot: number): boolean {
    return this.bypass.get(slot) === true;
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
    this.bypass.delete(slot);
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
   *   - for FX slots, writes upstream output (or `inBus` for the first slot)
   *     into the plugin's input;
   *   - calls noa_process;
   *   - reads output back into the bus.
   *
   * Writes the chain's final output (interleaved stereo) into `outBus`.
   * `outBus.length` must equal `blockSize * 2`. When the chain has no occupied
   * slots, `outBus` is zeroed.
   *
   * `inBus` (optional) is the upstream stereo signal feeding the chain. Only
   * consulted when the first occupied slot holds an FX-kind plugin (i.e. the
   * chain is an FX rack with no internal generator). For generator chains
   * `inBus` is ignored.
   */
  processBlock(blockSize: number, outBus: Float32Array, inBus?: Float32Array): void {
    if (blockSize > this.maxBlockSize) {
      throw new Error(`PluginChain.processBlock: blockSize ${blockSize} > maxBlockSize ${this.maxBlockSize}`);
    }
    if (outBus.length !== blockSize * 2) {
      throw new Error(`PluginChain.processBlock: outBus must be ${blockSize * 2} samples (got ${outBus.length})`);
    }
    if (inBus && inBus.length !== blockSize * 2) {
      throw new Error(`PluginChain.processBlock: inBus must be ${blockSize * 2} samples (got ${inBus.length})`);
    }

    // Reset bus to silence; subsequent slots overwrite it.
    this.bus.fill(0, 0, blockSize * 2);

    let hadAnySlot = false;
    let firstSlot = true;

    for (let slot = 0; slot < this.chain.length; slot++) {
      const inst = this.chain[slot];
      if (!inst) continue;
      hadAnySlot = true;

      // Bypassed FX: pass upstream audio (or external inBus on the first slot)
      // straight through the bus. Bypassed generators: emit silence. In both
      // cases, drain queued events to prevent them piling up over blocks.
      if (this.bypass.get(slot) === true) {
        const entry = this.slotEvents.get(slot);
        if (entry) entry.count = 0;
        if (inst.manifest.kind === 'fx') {
          if (firstSlot && inBus) this.bus.set(inBus.subarray(0, blockSize * 2));
          // else: bus already holds upstream output from the previous slot
        } else {
          this.bus.fill(0, 0, blockSize * 2);
        }
        firstSlot = false;
        continue;
      }

      inst.drainParamRing();

      const entry = this.slotEvents.get(slot);
      const nEvents = entry ? entry.count : 0;
      if (entry && nEvents > 0) {
        inst.pushEvents(entry.bytes, nEvents);
        entry.count = 0;
      }

      // FX slots take their input from the upstream slot's output. For the
      // first slot in an FX-only chain, that upstream is the external `inBus`.
      // Generators ignore input.
      if (inst.manifest.kind === 'fx') {
        if (firstSlot && inBus) {
          inst.writeInput(inBus.subarray(0, blockSize * 2));
        } else if (!firstSlot) {
          inst.writeInput(this.bus.subarray(0, blockSize * 2));
        }
      }

      inst.process(blockSize, nEvents);
      inst.readOutput(this.bus.subarray(0, blockSize * 2));
      firstSlot = false;
    }

    if (hadAnySlot) {
      outBus.set(this.bus.subarray(0, blockSize * 2));
    } else if (inBus) {
      // No plugins installed but caller supplied input — pass it through.
      outBus.set(inBus.subarray(0, blockSize * 2));
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
    this.bypass.clear();
  }
}
