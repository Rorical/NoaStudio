/**
 * MIDI input bridge. Decodes raw MIDI 1.0 messages, filters to NoteOn /
 * NoteOff, and pushes the corresponding EngineEvent frames onto the engine
 * ring. Channel-agnostic: every NoteOn from every device routes to whichever
 * `targetNumericId` is currently set; if no target is set, messages drop.
 *
 * Pure logic — takes the `pushEvent` callback and a target accessor via
 * constructor deps, so unit tests drive `handleMessage` with synthetic bytes
 * without a real `MIDIAccess`.
 *
 * Wiring in App.jsx: on first user gesture, call `navigator.requestMIDIAccess()`,
 * then `attach(input)` for every connected MIDIInput. The `onmidimessage`
 * handler this attaches forwards data to `handleMessage`.
 */
import {
  EVENT_FRAME_SIZE, encodeEvent,
  EVT_NOTE_ON, EVT_NOTE_OFF,
} from './EngineEvent';

export interface MidiInputDeps {
  pushEvent: (frame: Uint8Array) => void;
  /** Returns the EngineEvent targetId (numericId) to route MIDI notes to,
   *  or null/undefined if MIDI input should drop. */
  getTargetNumericId: () => number | null | undefined;
}

/**
 * Minimal shape we depend on from a Web MIDI `MIDIInput`. Tests pass a
 * matching stub; production passes the real object.
 */
export interface MidiInputLike {
  onmidimessage: ((e: { data: Uint8Array }) => void) | null;
}

export class MidiInput {
  /** Pre-allocated event frame to avoid per-message GC. */
  private readonly frame = new Uint8Array(EVENT_FRAME_SIZE);
  /** Inputs we've attached to, so detach() can clean up cleanly. */
  private readonly attached = new Set<MidiInputLike>();

  constructor(private readonly deps: MidiInputDeps) {}

  /** Hook this MidiInput up to a MIDIInput-like object. Re-attaching is a no-op. */
  attach(input: MidiInputLike): void {
    if (this.attached.has(input)) return;
    input.onmidimessage = (e) => this.handleMessage(e.data);
    this.attached.add(input);
  }

  /** Disconnect from a previously-attached input. */
  detach(input: MidiInputLike): void {
    if (!this.attached.has(input)) return;
    input.onmidimessage = null;
    this.attached.delete(input);
  }

  /** Disconnect from every attached input. */
  detachAll(): void {
    for (const input of this.attached) input.onmidimessage = null;
    this.attached.clear();
  }

  /**
   * Decode a raw 3-byte MIDI 1.0 message and push the corresponding
   * NoteOn/NoteOff frame, if any. Other messages (CC, pitch bend, aftertouch,
   * sysex, clock) are silently ignored — this v1 surfaces note events only.
   */
  handleMessage(data: Uint8Array): void {
    if (data.length < 3) return;
    const status = data[0]!;
    const command = status & 0xF0;
    const channel = status & 0x0F;
    const target = this.deps.getTargetNumericId();
    if (target === null || target === undefined) return;

    const note = data[1]!;
    const velocity = data[2]!;

    if (command === 0x90 && velocity > 0) {
      encodeEvent({
        type: EVT_NOTE_ON, sampleTime: 0,
        targetId: target, note, velocity, channel,
      }, this.frame);
      this.deps.pushEvent(this.frame);
    } else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
      // NoteOff, or "running-status NoteOff" via a velocity-0 NoteOn.
      encodeEvent({
        type: EVT_NOTE_OFF, sampleTime: 0,
        targetId: target, note, channel,
      }, this.frame);
      this.deps.pushEvent(this.frame);
    }
  }
}
