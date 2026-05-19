import { describe, it, expect } from 'vitest';
import { MidiInput, type MidiInputLike } from '../MidiInput';
import {
  EVENT_FRAME_SIZE, decodeEvent,
  EVT_NOTE_ON, EVT_NOTE_OFF,
} from '../EngineEvent';

function makeInput(target: number | null) {
  const frames: Uint8Array[] = [];
  const mi = new MidiInput({
    pushEvent: (frame) => {
      const copy = new Uint8Array(EVENT_FRAME_SIZE);
      copy.set(frame);
      frames.push(copy);
    },
    getTargetNumericId: () => target,
  });
  return { mi, frames };
}

describe('MidiInput.handleMessage', () => {
  it('decodes a NoteOn (status 0x90) and emits a NoteOn frame', () => {
    const { mi, frames } = makeInput(7);
    mi.handleMessage(new Uint8Array([0x90, 60, 100]));
    expect(frames).toHaveLength(1);
    const ev = decodeEvent(frames[0]!);
    expect(ev.type).toBe(EVT_NOTE_ON);
    // @ts-expect-error narrow
    expect(ev.note).toBe(60);
    // @ts-expect-error narrow
    expect(ev.velocity).toBe(100);
    // @ts-expect-error narrow
    expect(ev.targetId).toBe(7);
    // @ts-expect-error narrow
    expect(ev.channel).toBe(0);
  });

  it('preserves the MIDI channel low nibble', () => {
    const { mi, frames } = makeInput(7);
    mi.handleMessage(new Uint8Array([0x95, 60, 80])); // channel 5
    // @ts-expect-error narrow
    expect(decodeEvent(frames[0]!).channel).toBe(5);
  });

  it('decodes a velocity-0 NoteOn as NoteOff (running-status convention)', () => {
    const { mi, frames } = makeInput(7);
    mi.handleMessage(new Uint8Array([0x90, 60, 0]));
    expect(frames).toHaveLength(1);
    const ev = decodeEvent(frames[0]!);
    expect(ev.type).toBe(EVT_NOTE_OFF);
    // @ts-expect-error narrow
    expect(ev.note).toBe(60);
  });

  it('decodes a NoteOff (status 0x80) and emits a NoteOff frame', () => {
    const { mi, frames } = makeInput(7);
    mi.handleMessage(new Uint8Array([0x80, 60, 64]));
    expect(frames).toHaveLength(1);
    expect(decodeEvent(frames[0]!).type).toBe(EVT_NOTE_OFF);
  });

  it('ignores Control Change (0xB0) messages', () => {
    const { mi, frames } = makeInput(7);
    mi.handleMessage(new Uint8Array([0xB0, 7, 100])); // CC #7 (volume)
    expect(frames).toEqual([]);
  });

  it('ignores Pitch Bend (0xE0) messages', () => {
    const { mi, frames } = makeInput(7);
    mi.handleMessage(new Uint8Array([0xE0, 0, 64]));
    expect(frames).toEqual([]);
  });

  it('ignores short messages (< 3 bytes)', () => {
    const { mi, frames } = makeInput(7);
    mi.handleMessage(new Uint8Array([0x90, 60]));
    expect(frames).toEqual([]);
  });

  it('drops messages when no target is set', () => {
    const { mi, frames } = makeInput(null);
    mi.handleMessage(new Uint8Array([0x90, 60, 100]));
    expect(frames).toEqual([]);
  });

  it('attaches to an input and wires its onmidimessage', () => {
    const { mi, frames } = makeInput(3);
    const input: MidiInputLike = { onmidimessage: null };
    mi.attach(input);
    expect(input.onmidimessage).not.toBeNull();
    input.onmidimessage?.({ data: new Uint8Array([0x90, 60, 100]) });
    expect(frames).toHaveLength(1);
  });

  it('detach clears the input handler', () => {
    const { mi } = makeInput(3);
    const input: MidiInputLike = { onmidimessage: null };
    mi.attach(input);
    mi.detach(input);
    expect(input.onmidimessage).toBeNull();
  });

  it('detachAll clears every attached input', () => {
    const { mi } = makeInput(3);
    const a: MidiInputLike = { onmidimessage: null };
    const b: MidiInputLike = { onmidimessage: null };
    mi.attach(a);
    mi.attach(b);
    mi.detachAll();
    expect(a.onmidimessage).toBeNull();
    expect(b.onmidimessage).toBeNull();
  });

  it('attach is idempotent', () => {
    const { mi, frames } = makeInput(3);
    const input: MidiInputLike = { onmidimessage: null };
    mi.attach(input);
    const firstHandler = input.onmidimessage;
    mi.attach(input);
    expect(input.onmidimessage).toBe(firstHandler);
    input.onmidimessage?.({ data: new Uint8Array([0x90, 60, 100]) });
    expect(frames).toHaveLength(1);
  });
});
