import { describe, it, expect } from 'vitest';
import {
  EVENT_FRAME_SIZE,
  EVT_NOTE_ON, EVT_NOTE_OFF, EVT_PARAM_SET, EVT_TRANSPORT, EVT_TEMPO,
  TRANSPORT_PLAY, TRANSPORT_STOP,
  encodeEvent, decodeEvent,
  rewriteFrameOffset,
  type EngineEvent,
} from '../EngineEvent';

function roundTrip(ev: EngineEvent): EngineEvent {
  const buf = new Uint8Array(EVENT_FRAME_SIZE);
  encodeEvent(ev, buf);
  return decodeEvent(buf);
}

describe('EngineEvent', () => {
  it('frame size is 32 bytes', () => {
    expect(EVENT_FRAME_SIZE).toBe(32);
  });

  it('round-trips NoteOn', () => {
    const ev: EngineEvent = {
      type: EVT_NOTE_ON, sampleTime: 17, targetId: 42, note: 60, velocity: 100, channel: 2,
    };
    expect(roundTrip(ev)).toEqual(ev);
  });

  it('round-trips NoteOff', () => {
    const ev: EngineEvent = {
      type: EVT_NOTE_OFF, sampleTime: 0, targetId: 7, note: 64, channel: 0,
    };
    expect(roundTrip(ev)).toEqual(ev);
  });

  it('round-trips ParamSet with full f32 precision', () => {
    const ev: EngineEvent = {
      type: EVT_PARAM_SET, sampleTime: 99, targetId: 3, paramIndex: 12, value: 0.5,
    };
    expect(roundTrip(ev)).toEqual(ev);
  });

  it('round-trips Transport with f64 position', () => {
    const ev: EngineEvent = {
      type: EVT_TRANSPORT, sampleTime: 0, command: TRANSPORT_PLAY, positionBeats: 17.3125,
    };
    expect(roundTrip(ev)).toEqual(ev);
  });

  it('round-trips a stop event', () => {
    const ev: EngineEvent = {
      type: EVT_TRANSPORT, sampleTime: 0, command: TRANSPORT_STOP, positionBeats: 0,
    };
    expect(roundTrip(ev)).toEqual(ev);
  });

  it('round-trips Tempo', () => {
    const ev: EngineEvent = { type: EVT_TEMPO, sampleTime: 0, bpm: 124 };
    expect(roundTrip(ev)).toEqual(ev);
  });

  it('rejects buffers of the wrong size', () => {
    const ev: EngineEvent = {
      type: EVT_NOTE_ON, sampleTime: 0, targetId: 0, note: 60, velocity: 100, channel: 0,
    };
    expect(() => encodeEvent(ev, new Uint8Array(31))).toThrow();
  });

  it('throws on unknown type byte during decode', () => {
    const buf = new Uint8Array(EVENT_FRAME_SIZE);
    buf[0] = 99;
    expect(() => decodeEvent(buf)).toThrow(/unknown event type/);
  });
});

describe('rewriteFrameOffset', () => {
  it('replaces bytes 4-7 with the new frameOffset value, leaving the rest of the frame intact', () => {
    const buf = new Uint8Array(EVENT_FRAME_SIZE);
    encodeEvent({
      type: EVT_NOTE_ON, sampleTime: 123456, targetId: 7, note: 60, velocity: 100, channel: 0,
    }, buf);
    const beforeBytes = Array.from(buf);
    rewriteFrameOffset(buf, 42);
    // bytes 4-7 are now the little-endian u32 42
    expect(buf[4]).toBe(42);
    expect(buf[5]).toBe(0);
    expect(buf[6]).toBe(0);
    expect(buf[7]).toBe(0);
    // everything else is unchanged
    for (let i = 0; i < 4; i++) expect(buf[i]).toBe(beforeBytes[i]);
    for (let i = 8; i < EVENT_FRAME_SIZE; i++) expect(buf[i]).toBe(beforeBytes[i]);
    // The plugin-side decode (treating bytes 4-7 as frameOffset) sees the new value;
    // decodeEvent re-reads them as sampleTime since the byte layout overlaps.
    const decoded = decodeEvent(buf);
    expect(decoded.sampleTime).toBe(42);
  });

  it('handles offset 0 (NoteOn fires at block start)', () => {
    const buf = new Uint8Array(EVENT_FRAME_SIZE);
    encodeEvent({
      type: EVT_NOTE_ON, sampleTime: 5000, targetId: 1, note: 64, velocity: 90, channel: 0,
    }, buf);
    rewriteFrameOffset(buf, 0);
    expect(decodeEvent(buf).sampleTime).toBe(0);
  });

  it('handles large offsets up to u32 max', () => {
    const buf = new Uint8Array(EVENT_FRAME_SIZE);
    encodeEvent({
      type: EVT_NOTE_ON, sampleTime: 0, targetId: 1, note: 64, velocity: 90, channel: 0,
    }, buf);
    rewriteFrameOffset(buf, 0xFFFFFFFF);
    expect(decodeEvent(buf).sampleTime).toBe(0xFFFFFFFF);
  });

  it('rejects frames of the wrong size', () => {
    expect(() => rewriteFrameOffset(new Uint8Array(31), 0)).toThrow(/bytes/);
    expect(() => rewriteFrameOffset(new Uint8Array(33), 0)).toThrow(/bytes/);
  });
});
