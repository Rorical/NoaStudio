import { describe, it, expect } from 'vitest';
import { allocRingBuffer, RingBuffer, RB_HEADER_BYTES } from '../RingBuffer';

const FRAME = 8;

function makeFrame(byteValue: number): Uint8Array {
  return new Uint8Array(FRAME).fill(byteValue);
}

describe('allocRingBuffer', () => {
  it('rejects non-power-of-2 capacities', () => {
    expect(() => allocRingBuffer(3, FRAME)).toThrow(/power of 2/);
    expect(() => allocRingBuffer(0, FRAME)).toThrow();
  });

  it('rejects frame sizes that are not positive multiples of 4', () => {
    expect(() => allocRingBuffer(8, 0)).toThrow();
    expect(() => allocRingBuffer(8, 5)).toThrow();
  });

  it('writes capacity and frameSize into the header', () => {
    const { sab } = allocRingBuffer(8, FRAME);
    const header = new Uint32Array(sab, 0, 4);
    expect(header[2]).toBe(8);
    expect(header[3]).toBe(FRAME);
    expect(sab.byteLength).toBe(RB_HEADER_BYTES + 8 * FRAME);
  });
});

describe('RingBuffer push/pop', () => {
  it('starts empty', () => {
    const { sab } = allocRingBuffer(4, FRAME);
    const rb = new RingBuffer(sab);
    expect(rb.size()).toBe(0);
    expect(rb.pop(new Uint8Array(FRAME))).toBe(false);
  });

  it('round-trips a single frame', () => {
    const { sab } = allocRingBuffer(4, FRAME);
    const rb = new RingBuffer(sab);
    expect(rb.push(makeFrame(0xab))).toBe(true);
    expect(rb.size()).toBe(1);
    const out = new Uint8Array(FRAME);
    expect(rb.pop(out)).toBe(true);
    expect(Array.from(out)).toEqual(Array(FRAME).fill(0xab));
    expect(rb.size()).toBe(0);
  });

  it('rejects pushes when full and rejects pops when empty', () => {
    const { sab } = allocRingBuffer(4, FRAME);
    const rb = new RingBuffer(sab);
    for (let i = 0; i < 4; i++) expect(rb.push(makeFrame(i))).toBe(true);
    expect(rb.push(makeFrame(99))).toBe(false);
    const out = new Uint8Array(FRAME);
    for (let i = 0; i < 4; i++) {
      expect(rb.pop(out)).toBe(true);
      expect(out[0]).toBe(i);
    }
    expect(rb.pop(out)).toBe(false);
  });

  it('wraps past the capacity boundary', () => {
    const { sab } = allocRingBuffer(4, FRAME);
    const rb = new RingBuffer(sab);
    const out = new Uint8Array(FRAME);
    for (let cycle = 0; cycle < 10; cycle++) {
      expect(rb.push(makeFrame(cycle))).toBe(true);
      expect(rb.pop(out)).toBe(true);
      expect(out[0]).toBe(cycle);
    }
    expect(rb.size()).toBe(0);
  });

  it('two views over the same SAB see each others writes', () => {
    const { sab } = allocRingBuffer(8, FRAME);
    const producer = new RingBuffer(sab);
    const consumer = new RingBuffer(sab);
    producer.push(makeFrame(0x7e));
    const out = new Uint8Array(FRAME);
    expect(consumer.pop(out)).toBe(true);
    expect(out[0]).toBe(0x7e);
  });

  it('throws on frame size mismatch', () => {
    const { sab } = allocRingBuffer(4, FRAME);
    const rb = new RingBuffer(sab);
    expect(() => rb.push(new Uint8Array(FRAME + 1))).toThrow(/frame size/);
    expect(() => rb.pop(new Uint8Array(FRAME - 4))).toThrow(/frame size/);
  });
});
