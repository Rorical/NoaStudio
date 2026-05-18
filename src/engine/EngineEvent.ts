/**
 * Binary event frames pumped through the engine event ring (main thread → worklet)
 * and into plugin per-block event buffers (worklet → plugin).
 *
 * The 32-byte frame layout is identical on both sides of the ring; what changes
 * is the *meaning* of bytes 4–7:
 *
 *  - **On the main → worklet ring**, bytes 4–7 are `sampleTime` — an absolute
 *    sample-count at which the event should fire. Phase 6a's ClipScheduler
 *    pushes events ahead of time with the target sample-time so the worklet
 *    can dispatch sample-accurately within the right render quantum.
 *  - **In the plugin's per-block event buffer**, bytes 4–7 are `frameOffset`
 *    — the sample index *within the current 128-frame block* at which the
 *    plugin should react. The worklet translates `sampleTime → frameOffset`
 *    before queueing into the plugin's buffer.
 *
 * Limit: u32 holds ~89,000 seconds of audio at 48 kHz (≈ 24 h 50 m). A future
 * phase can widen to u64 if/when long sessions become a thing.
 *
 * For backwards-compat with the immediate-dispatch call-sites (UI param tweaks,
 * NoteOn from a keypress), pushing an event with `sampleTime = 0` is a sentinel
 * for "fire on the next block at frameOffset 0".
 */
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
  sampleTime: number;
  targetId: number;
  note: number;
  velocity: number;
  channel: number;
}

export interface NoteOffEvent {
  type: typeof EVT_NOTE_OFF;
  sampleTime: number;
  targetId: number;
  note: number;
  channel: number;
}

export interface ParamSetEvent {
  type: typeof EVT_PARAM_SET;
  sampleTime: number;
  targetId: number;
  paramIndex: number;
  value: number;
}

export interface TransportEvent {
  type: typeof EVT_TRANSPORT;
  sampleTime: number;
  command: number;
  positionBeats: number;
}

export interface TempoEvent {
  type: typeof EVT_TEMPO;
  sampleTime: number;
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
  for (let i = 8; i < EVENT_FRAME_SIZE; i++) out[i] = 0;
  v.setUint8(0, ev.type);
  v.setUint8(1, 0);
  v.setUint16(2, 0, true);
  v.setUint32(4, ev.sampleTime, true);
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
  const sampleTime = v.getUint32(4, true);
  switch (type) {
    case EVT_NOTE_ON:
      return {
        type: EVT_NOTE_ON, sampleTime,
        targetId: v.getUint32(8, true),
        note: v.getUint8(12),
        velocity: v.getUint8(13),
        channel: v.getUint8(14),
      };
    case EVT_NOTE_OFF:
      return {
        type: EVT_NOTE_OFF, sampleTime,
        targetId: v.getUint32(8, true),
        note: v.getUint8(12),
        channel: v.getUint8(13),
      };
    case EVT_PARAM_SET:
      return {
        type: EVT_PARAM_SET, sampleTime,
        targetId: v.getUint32(8, true),
        paramIndex: v.getUint32(12, true),
        value: v.getFloat32(16, true),
      };
    case EVT_TRANSPORT:
      return {
        type: EVT_TRANSPORT, sampleTime,
        command: v.getUint8(8),
        positionBeats: v.getFloat64(16, true),
      };
    case EVT_TEMPO:
      return {
        type: EVT_TEMPO, sampleTime,
        bpm: v.getFloat32(8, true),
      };
    default:
      throw new Error(`unknown event type: ${type}`);
  }
}

/**
 * Rewrite an already-encoded frame's `sampleTime` field with `frameOffset`
 * — used by the worklet right before queueing an event into a plugin's
 * per-block buffer. Same 4 bytes at offset 4; only the semantic interpretation
 * changes. Cheap (one DataView write), no decode/re-encode.
 */
export function rewriteFrameOffset(frame: Uint8Array, frameOffset: number): void {
  if (frame.length !== EVENT_FRAME_SIZE) {
    throw new Error(`rewriteFrameOffset: frame must be ${EVENT_FRAME_SIZE} bytes`);
  }
  new DataView(frame.buffer, frame.byteOffset, EVENT_FRAME_SIZE)
    .setUint32(4, frameOffset, true);
}
