import { describe, it, expect } from 'vitest';
import {
  EVENT_FRAME_SIZE,
  EVT_NOTE_ON, EVT_NOTE_OFF, EVT_PARAM_SET, EVT_TRANSPORT, EVT_TEMPO,
  TRANSPORT_PLAY, TRANSPORT_STOP,
  encodeEvent, decodeEvent,
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
