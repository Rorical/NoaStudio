import { describe, it, expect } from 'vitest';
import { SineGenerator } from '../SineGenerator';
import {
  EVT_NOTE_ON, EVT_NOTE_OFF, type EngineEvent,
} from '../../EngineEvent';

const SR = 48000;

function noteOn(note: number, velocity: number, frameOffset = 0): EngineEvent {
  return { type: EVT_NOTE_ON, frameOffset, targetId: 0, note, velocity, channel: 0 };
}
function noteOff(note: number, frameOffset = 0): EngineEvent {
  return { type: EVT_NOTE_OFF, frameOffset, targetId: 0, note, channel: 0 };
}

function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / buf.length);
}

describe('SineGenerator', () => {
  it('produces silence with no notes', () => {
    const g = new SineGenerator(SR);
    const out = new Float32Array(128);
    g.process([], out);
    expect(rms(out)).toBe(0);
  });

  it('produces non-zero output after NoteOn', () => {
    const g = new SineGenerator(SR);
    const out = new Float32Array(2048);
    g.process([noteOn(69, 100)], out);
    expect(rms(out)).toBeGreaterThan(0.01);
  });

  it('NoteOn frequency approximates the MIDI pitch (A4 = 440 Hz)', () => {
    const g = new SineGenerator(SR);
    const out = new Float32Array(SR); // 1 second
    g.process([noteOn(69, 127)], out);
    // Count zero crossings on the positive-going edge.
    let crossings = 0;
    for (let i = 1; i < out.length; i++) {
      if (out[i - 1]! <= 0 && out[i]! > 0) crossings++;
    }
    expect(crossings).toBeGreaterThan(420);
    expect(crossings).toBeLessThan(460);
  });

  it('NoteOff causes amplitude decay to zero', () => {
    const g = new SineGenerator(SR);
    const a = new Float32Array(1024);
    g.process([noteOn(60, 127)], a);
    const before = rms(a);
    const b = new Float32Array(4096);
    g.process([noteOff(60)], b);
    // Tail of the buffer should be (near) silent after release.
    const tail = b.subarray(b.length - 256);
    expect(rms(tail)).toBeLessThan(before * 0.05);
  });

  it('honors frameOffset for within-block timing', () => {
    const g = new SineGenerator(SR);
    const out = new Float32Array(256);
    g.process([noteOn(69, 127, 128)], out);
    // Samples before frameOffset should be silent.
    const head = out.subarray(0, 128);
    const tail = out.subarray(128);
    expect(rms(head)).toBe(0);
    expect(rms(tail)).toBeGreaterThan(0.01);
  });

  it('supports multiple simultaneous voices', () => {
    const g = new SineGenerator(SR);
    const out = new Float32Array(2048);
    g.process([noteOn(60, 100), noteOn(64, 100), noteOn(67, 100)], out);
    // Three voices summed should produce greater RMS than one.
    const g1 = new SineGenerator(SR);
    const out1 = new Float32Array(2048);
    g1.process([noteOn(60, 100)], out1);
    expect(rms(out)).toBeGreaterThan(rms(out1));
  });

  it('ignores unrelated event types without throwing', () => {
    const g = new SineGenerator(SR);
    const out = new Float32Array(128);
    g.process([{ type: 4 as const, frameOffset: 0, command: 1, positionBeats: 0 }], out);
    expect(rms(out)).toBe(0);
  });
});
