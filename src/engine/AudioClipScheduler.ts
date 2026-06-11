/**
 * Look-ahead audio-clip scheduler. The sibling of {@link ClipScheduler} for
 * audio (PCM) clips: it runs on the main thread (~60 Hz via RAF), scans the
 * project's audio clips up to a small horizon, and pushes paired
 * `EVT_AUDIO_ON` / `EVT_AUDIO_OFF` frames with absolute sample-time onto the
 * engine event ring. The worklet's AudioClipPlayer starts/stops voices
 * sample-accurately within the right render quantum — the exact same
 * dispatch path notes flow through, so timing matches MIDI.
 *
 * Anchor / horizon / loop-reset semantics deliberately mirror ClipScheduler so
 * audio and MIDI stay in lock-step. Pure logic — tests drive `tick()` with a
 * controllable fake clock.
 */
import {
  EVENT_FRAME_SIZE, encodeEvent,
  EVT_AUDIO_ON, EVT_AUDIO_OFF,
} from './EngineEvent';
import { channelHash } from './channelHash';

export interface AudioClipSchedulerDeps {
  sampleRate: number;
  lookaheadSamples: number;
  readCurrentSample: () => number;
  pushEvent: (frame: Uint8Array) => void;
}

export interface AudioSchedulerTrack {
  id: string;
  /** Mixer channel id this track's audio clips play into ('m' + track.channel). */
  channelId: string;
  mute: boolean;
  solo: boolean;
}

export interface AudioSchedulerClip {
  trackId: string;
  start: number;
  length: number;
  /** Present on audio clips; clips without a sampleId are skipped. */
  sampleId?: string;
  /** Optional per-clip linear gain (default 1). */
  gain?: number;
}

export interface AudioSchedulerProject {
  bpm: number;
  tracks: AudioSchedulerTrack[];
  clips: AudioSchedulerClip[];
}

interface ActiveVoice {
  voiceId: number;
  /** Engine sample-time at which this voice's paired AudioOff was scheduled. */
  offSampleTime: number;
  channelHash: number;
}

export class AudioClipScheduler {
  private project: AudioSchedulerProject | null = null;
  private running = false;
  private startSample = 0;
  private startBeat = 0;
  private cursorBeat = 0;
  private active: ActiveVoice[] = [];
  /** Monotonic per-voice id (wraps in u32, never 0). */
  private nextVoiceId = 1;
  /** Set on start()/reset(); the next tick triggers any clip already underway
   *  at the anchor beat (transport started, or a loop re-anchored, mid-clip). */
  private straddlePending = false;
  private readonly frame = new Uint8Array(EVENT_FRAME_SIZE);

  constructor(private readonly deps: AudioClipSchedulerDeps) {}

  setProject(p: AudioSchedulerProject): void {
    this.project = p;
  }

  start(args: { startSample: number; startBeat: number }): void {
    this.startSample = args.startSample;
    this.startBeat = args.startBeat;
    this.cursorBeat = args.startBeat;
    this.running = true;
    this.straddlePending = true;
  }

  /**
   * Stop scheduling and immediately silence every still-playing voice by
   * emitting an extra AudioOff (sampleTime: 0). The originally-queued AudioOff
   * is left in the ring; when it fires it's a no-op (stopping an already-stopped
   * voice id).
   */
  stop(): void {
    this.running = false;
    const currentSample = this.deps.readCurrentSample();
    for (const a of this.active) {
      if (a.offSampleTime <= currentSample) continue;
      this.emitAudioOff(a.voiceId, 0);
    }
    this.active = [];
  }

  /** Re-anchor after a loop wrap. Mirrors ClipScheduler.reset. */
  reset(args: { startSample: number; startBeat: number }): void {
    this.startSample = args.startSample;
    this.startBeat = args.startBeat;
    this.cursorBeat = args.startBeat;
    this.straddlePending = true;
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

    if (this.active.length > 0) {
      this.active = this.active.filter((a) => a.offSampleTime > currentSample);
    }

    const anySolo = project.tracks.some((t) => t.solo);

    // One-time straddle scan: trigger clips whose body already contains the
    // anchor beat (transport started, or a loop re-anchored, mid-clip). Plays
    // them from the correct intra-sample offset rather than dropping them.
    if (this.straddlePending) {
      this.straddlePending = false;
      for (const track of project.tracks) {
        if (anySolo ? !track.solo : track.mute) continue;
        const chHash = channelHash(track.channelId);
        for (const clip of project.clips) {
          if (clip.trackId !== track.id || !clip.sampleId) continue;
          if (clip.start >= this.cursorBeat || clip.start + clip.length <= this.cursorBeat) continue;
          const startFrame = Math.round((this.cursorBeat - clip.start) * samplesPerBeat);
          const offsetSample = Math.round(
            this.startSample + (clip.start + clip.length - this.startBeat) * samplesPerBeat,
          );
          const voiceId = this.mintVoiceId();
          this.emitAudioOn(voiceId, channelHash(clip.sampleId), chHash, clip.gain ?? 1, currentSample, startFrame);
          this.emitAudioOff(voiceId, offsetSample);
          this.active.push({ voiceId, offSampleTime: offsetSample, channelHash: chHash });
        }
      }
    }

    if (horizonBeat <= this.cursorBeat) return;

    for (const track of project.tracks) {
      if (anySolo ? !track.solo : track.mute) continue;
      const chHash = channelHash(track.channelId);
      for (const clip of project.clips) {
        if (clip.trackId !== track.id) continue;
        if (!clip.sampleId) continue;
        const onsetBeat = clip.start;
        if (onsetBeat < this.cursorBeat) continue;
        if (onsetBeat >= horizonBeat) continue;
        const onsetSample = Math.round(
          this.startSample + (onsetBeat - this.startBeat) * samplesPerBeat,
        );
        const offsetSample = Math.round(
          this.startSample + (onsetBeat + clip.length - this.startBeat) * samplesPerBeat,
        );
        const voiceId = this.mintVoiceId();
        this.emitAudioOn(voiceId, channelHash(clip.sampleId), chHash, clip.gain ?? 1, onsetSample);
        this.emitAudioOff(voiceId, offsetSample);
        this.active.push({ voiceId, offSampleTime: offsetSample, channelHash: chHash });
      }
    }

    this.cursorBeat = horizonBeat;
  }

  private mintVoiceId(): number {
    const id = this.nextVoiceId;
    this.nextVoiceId = ((this.nextVoiceId + 1) >>> 0) || 1;
    return id;
  }

  private emitAudioOn(
    voiceId: number, sampleHash: number, channelHash: number, gain: number,
    sampleTime: number, startFrame = 0,
  ): void {
    encodeEvent({
      type: EVT_AUDIO_ON, sampleTime,
      voiceId, sampleHash, channelHash, startFrame, gain,
    }, this.frame);
    this.deps.pushEvent(this.frame);
  }

  private emitAudioOff(voiceId: number, sampleTime: number): void {
    encodeEvent({ type: EVT_AUDIO_OFF, sampleTime, voiceId }, this.frame);
    this.deps.pushEvent(this.frame);
  }
}
