export const RB_HEADER_BYTES = 16;

const W_IDX = 0;
const R_IDX = 1;
const CAP_IDX = 2;
const FRAME_IDX = 3;

export interface RingBufferLayout {
  sab: SharedArrayBuffer;
  capacity: number;
  frameSize: number;
}

function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

export function allocRingBuffer(capacity: number, frameSize: number): RingBufferLayout {
  if (!isPow2(capacity)) {
    throw new Error(`RingBuffer capacity must be a power of 2 (got ${capacity})`);
  }
  if (!Number.isInteger(frameSize) || frameSize <= 0 || frameSize % 4 !== 0) {
    throw new Error(`RingBuffer frameSize must be a positive multiple of 4 (got ${frameSize})`);
  }
  const bytes = RB_HEADER_BYTES + capacity * frameSize;
  const sab = new SharedArrayBuffer(bytes);
  const header = new Uint32Array(sab, 0, 4);
  header[CAP_IDX] = capacity;
  header[FRAME_IDX] = frameSize;
  return { sab, capacity, frameSize };
}

export class RingBuffer {
  private readonly header: Uint32Array;
  private readonly data: Uint8Array;
  private readonly mask: number;
  readonly capacity: number;
  readonly frameSize: number;

  constructor(sab: SharedArrayBuffer) {
    this.header = new Uint32Array(sab, 0, 4);
    this.capacity = Atomics.load(this.header, CAP_IDX);
    this.frameSize = Atomics.load(this.header, FRAME_IDX);
    if (!isPow2(this.capacity)) {
      throw new Error(`RingBuffer SAB header is malformed (capacity=${this.capacity})`);
    }
    this.mask = this.capacity - 1;
    this.data = new Uint8Array(sab, RB_HEADER_BYTES, this.capacity * this.frameSize);
  }

  push(frame: Uint8Array): boolean {
    if (frame.length !== this.frameSize) {
      throw new Error(`RingBuffer frame size mismatch: expected ${this.frameSize}, got ${frame.length}`);
    }
    const write = Atomics.load(this.header, W_IDX);
    const read = Atomics.load(this.header, R_IDX);
    if (write - read >= this.capacity) return false;
    const slot = (write & this.mask) * this.frameSize;
    this.data.set(frame, slot);
    Atomics.store(this.header, W_IDX, write + 1);
    return true;
  }

  pop(out: Uint8Array): boolean {
    if (out.length !== this.frameSize) {
      throw new Error(`RingBuffer frame size mismatch: expected ${this.frameSize}, got ${out.length}`);
    }
    const write = Atomics.load(this.header, W_IDX);
    const read = Atomics.load(this.header, R_IDX);
    if (read === write) return false;
    const slot = (read & this.mask) * this.frameSize;
    out.set(this.data.subarray(slot, slot + this.frameSize));
    Atomics.store(this.header, R_IDX, read + 1);
    return true;
  }

  size(): number {
    const write = Atomics.load(this.header, W_IDX);
    const read = Atomics.load(this.header, R_IDX);
    return write - read;
  }
}
