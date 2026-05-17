export const EVENT_FRAME_SIZE = 32;

export const EVT_NOTE_ON = 1 as const;
export const EVT_NOTE_OFF = 2 as const;
export const EVT_PARAM_SET = 3 as const;
export const EVT_TRANSPORT = 4 as const;
export const EVT_TEMPO = 5 as const;

export const TRANSPORT_STOP = 0 as const;
export const TRANSPORT_PLAY = 1 as const;
export const TRANSPORT_PAUSE = 2 as const;

export interface NoteOnEvent {
  type: typeof EVT_NOTE_ON;
  frameOffset: number;
  targetId: number;
  note: number;
  velocity: number;
  channel: number;
}

export interface NoteOffEvent {
  type: typeof EVT_NOTE_OFF;
  frameOffset: number;
  targetId: number;
  note: number;
  channel: number;
}

export interface ParamSetEvent {
  type: typeof EVT_PARAM_SET;
  frameOffset: number;
  targetId: number;
  paramIndex: number;
  value: number;
}

export interface TransportEvent {
  type: typeof EVT_TRANSPORT;
  frameOffset: number;
  command: number;
  positionBeats: number;
}

export interface TempoEvent {
  type: typeof EVT_TEMPO;
  frameOffset: number;
  bpm: number;
}

export type EngineEvent =
  | NoteOnEvent | NoteOffEvent | ParamSetEvent | TransportEvent | TempoEvent;

function viewOf(buf: Uint8Array): DataView {
  if (buf.length !== EVENT_FRAME_SIZE) {
    throw new Error(`EngineEvent buffer must be ${EVENT_FRAME_SIZE} bytes (got ${buf.length})`);
  }
  return new DataView(buf.buffer, buf.byteOffset, EVENT_FRAME_SIZE);
}

export function encodeEvent(ev: EngineEvent, out: Uint8Array): void {
  const v = viewOf(out);
  // Zero the payload region so old data never leaks into decode comparisons.
  for (let i = 8; i < EVENT_FRAME_SIZE; i++) out[i] = 0;
  v.setUint8(0, ev.type);
  v.setUint8(1, 0);
  v.setUint16(2, 0, true);
  v.setUint32(4, ev.frameOffset, true);
  switch (ev.type) {
    case EVT_NOTE_ON:
      v.setUint32(8, ev.targetId, true);
      v.setUint8(12, ev.note);
      v.setUint8(13, ev.velocity);
      v.setUint8(14, ev.channel);
      return;
    case EVT_NOTE_OFF:
      v.setUint32(8, ev.targetId, true);
      v.setUint8(12, ev.note);
      v.setUint8(13, ev.channel);
      return;
    case EVT_PARAM_SET:
      v.setUint32(8, ev.targetId, true);
      v.setUint32(12, ev.paramIndex, true);
      v.setFloat32(16, ev.value, true);
      return;
    case EVT_TRANSPORT:
      v.setUint8(8, ev.command);
      v.setFloat64(16, ev.positionBeats, true);
      return;
    case EVT_TEMPO:
      v.setFloat32(8, ev.bpm, true);
      return;
  }
}

export function decodeEvent(buf: Uint8Array): EngineEvent {
  const v = viewOf(buf);
  const type = v.getUint8(0);
  const frameOffset = v.getUint32(4, true);
  switch (type) {
    case EVT_NOTE_ON:
      return {
        type: EVT_NOTE_ON, frameOffset,
        targetId: v.getUint32(8, true),
        note: v.getUint8(12),
        velocity: v.getUint8(13),
        channel: v.getUint8(14),
      };
    case EVT_NOTE_OFF:
      return {
        type: EVT_NOTE_OFF, frameOffset,
        targetId: v.getUint32(8, true),
        note: v.getUint8(12),
        channel: v.getUint8(13),
      };
    case EVT_PARAM_SET:
      return {
        type: EVT_PARAM_SET, frameOffset,
        targetId: v.getUint32(8, true),
        paramIndex: v.getUint32(12, true),
        value: v.getFloat32(16, true),
      };
    case EVT_TRANSPORT:
      return {
        type: EVT_TRANSPORT, frameOffset,
        command: v.getUint8(8),
        positionBeats: v.getFloat64(16, true),
      };
    case EVT_TEMPO:
      return {
        type: EVT_TEMPO, frameOffset,
        bpm: v.getFloat32(8, true),
      };
    default:
      throw new Error(`unknown event type: ${type}`);
  }
}
