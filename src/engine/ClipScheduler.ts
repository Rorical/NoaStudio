/**
 * Look-ahead MIDI scheduler. Runs on the main thread (~60 Hz via RAF). Reads
 * the engine's sample counter, scans the project's clips up to a small
 * horizon, and pushes paired NoteOn/NoteOff events with absolute sample-time
 * onto the engine event ring. The worklet's MixerRouter dispatches them
 * sample-accurately within the right render quantum.
 *
 * Pure logic — no audio context, no DOM. Tests drive `tick()` with a
 * controllable fake clock.
 *
 * Loop handling is delegated to the caller: when the playhead wraps from
 * `loopEnd` back to `loopStart`, the caller invokes `reset({startSample,
 * startBeat})` to re-anchor the scheduler. The scheduler does not chase the
 * wrap on its own.
 */
import {
  EVENT_FRAME_SIZE, encodeEvent,
  EVT_NOTE_ON, EVT_NOTE_OFF,
} from './EngineEvent';

export interface ClipSchedulerDeps {
  sampleRate: number;
  lookaheadSamples: number;
  readCurrentSample: () => number;
  pushEvent: (frame: Uint8Array) => void;
}

export interface ClipSchedulerTrack {
  id: string;
  mute: boolean;
  solo: boolean;
  /** EngineEvent.targetId for the track's generator. Optional — tracks without
   *  a generator are skipped. */
  generatorNumericId?: number;
}

export interface ClipSchedulerClip {
  trackId: string;
  start: number;
  length: number;
  pattern?: { notes: [number, number, number][] };
}

export interface ClipSchedulerProject {
  bpm: number;
  tracks: ClipSchedulerTrack[];
  clips: ClipSchedulerClip[];
}

interface ActiveNote {
  targetId: number;
  note: number;
  channel: number;
  /** Engine sample-time at which this note's paired NoteOff was scheduled. */
  offSampleTime: number;
}

export class ClipScheduler {
  private project: ClipSchedulerProject | null = null;
  private running = false;
  /** Engine sample count when the current run started. */
  private startSample = 0;
  /** Project beat at startSample. */
  private startBeat = 0;
  /** Earliest beat not yet scheduled. */
  private cursorBeat = 0;
  /** Notes whose paired NoteOff is still in the future. Used by `stop()` to
   *  release ringing voices immediately instead of waiting for the queued
   *  NoteOff to fire. */
  private active: ActiveNote[] = [];
  /** Reusable frame buffer to avoid per-event allocs on the main thread. */
  private readonly frame = new Uint8Array(EVENT_FRAME_SIZE);

  constructor(private readonly deps: ClipSchedulerDeps) {}

  setProject(p: ClipSchedulerProject): void {
    this.project = p;
  }

  start(args: { startSample: number; startBeat: number }): void {
    this.startSample = args.startSample;
    this.startBeat = args.startBeat;
    this.cursorBeat = args.startBeat;
    this.running = true;
  }

  /**
   * Stop scheduling new events and immediately release every still-ringing
   * note by emitting an extra NoteOff (sampleTime: 0). The original paired
   * NoteOff is left in the engine ring — when it eventually fires it's a
   * no-op (releasing an already-released voice).
   */
  stop(): void {
    this.running = false;
    const currentSample = this.deps.readCurrentSample();
    for (const a of this.active) {
      if (a.offSampleTime <= currentSample) continue;
      encodeEvent({
        type: EVT_NOTE_OFF, sampleTime: 0,
        targetId: a.targetId, note: a.note, channel: a.channel,
      }, this.frame);
      this.deps.pushEvent(this.frame);
    }
    this.active = [];
  }

  /** Re-anchor the scheduler after a loop wrap. */
  reset(args: { startSample: number; startBeat: number }): void {
    this.startSample = args.startSample;
    this.startBeat = args.startBeat;
    this.cursorBeat = args.startBeat;
    // Notes that hadn't released yet may have their paired NoteOff queued
    // before the new anchor — let them fire on the engine clock as-is.
    // Just prune the local active list relative to current sample.
    const currentSample = this.deps.readCurrentSample();
    this.active = this.active.filter((a) => a.offSampleTime > currentSample);
  }

  tick(): void {
    if (!this.running || !this.project) return;
    const project = this.project;
    const samplesPerBeat = (this.deps.sampleRate * 60) / project.bpm;
    const lookaheadBeats = this.deps.lookaheadSamples / samplesPerBeat;
    const currentSample = this.deps.readCurrentSample();
    const currentBeat = (currentSample - this.startSample) / samplesPerBeat + this.startBeat;
    const horizonBeat = currentBeat + lookaheadBeats;

    // Prune notes whose NoteOff has already fired on the engine clock.
    if (this.active.length > 0) {
      this.active = this.active.filter((a) => a.offSampleTime > currentSample);
    }

    if (horizonBeat <= this.cursorBeat) return;

    const anySolo = project.tracks.some((t) => t.solo);

    for (const track of project.tracks) {
      if (anySolo ? !track.solo : track.mute) continue;
      if (track.generatorNumericId === undefined) continue;
      const targetId = track.generatorNumericId;
      for (const clip of project.clips) {
        if (clip.trackId !== track.id) continue;
        if (!clip.pattern) continue;
        const clipStart = clip.start;
        const clipEnd = clip.start + clip.length;
        if (clipEnd <= this.cursorBeat) continue;
        if (clipStart >= horizonBeat) continue;
        for (const [noteBeatInClip, pitch, lengthBeats] of clip.pattern.notes) {
          const onsetBeat = clipStart + noteBeatInClip;
          if (onsetBeat < this.cursorBeat) continue;
          if (onsetBeat >= horizonBeat) continue;
          const onsetSample = Math.round(
            this.startSample + (onsetBeat - this.startBeat) * samplesPerBeat,
          );
          const offsetSample = Math.round(
            onsetSample + lengthBeats * samplesPerBeat,
          );
          this.emitNoteOn(targetId, pitch, onsetSample);
          this.emitNoteOff(targetId, pitch, offsetSample);
          this.active.push({
            targetId, note: pitch, channel: 0, offSampleTime: offsetSample,
          });
        }
      }
    }

    this.cursorBeat = horizonBeat;
  }

  private emitNoteOn(targetId: number, note: number, sampleTime: number): void {
    encodeEvent({
      type: EVT_NOTE_ON, sampleTime,
      targetId, note, velocity: 100, channel: 0,
    }, this.frame);
    this.deps.pushEvent(this.frame);
  }

  private emitNoteOff(targetId: number, note: number, sampleTime: number): void {
    encodeEvent({
      type: EVT_NOTE_OFF, sampleTime,
      targetId, note, channel: 0,
    }, this.frame);
    this.deps.pushEvent(this.frame);
  }
}
