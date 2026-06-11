/**
 * Worklet-side audio-clip voice player. Holds decoded PCM samples (shipped from
 * the main thread via LOAD_SAMPLE, keyed by a string-hash of the sampleId) plus
 * a list of active voices. Each render block, every active voice reads its
 * sample forward and mixes (adds) into the channel input bus resolved by the
 * host via the `mixInto` callback.
 *
 * Pure logic — no AudioWorklet dependency — so the cursor / mix / auto-stop math
 * is unit-testable in Node. The worklet owns one instance and calls `render()`
 * from inside `MixerRouter.processBlock`, right after the generator chains have
 * filled the channel input buses and before the channels are walked, so an audio
 * voice flows through its channel's FX rack, fader, pan and sends exactly like
 * generator audio.
 */

export interface SampleData {
  /** Interleaved PCM: frame f, channel c lives at pcm[f * channels + c]. */
  pcm: Float32Array;
  channels: number;
  frames: number;
}

interface Voice {
  id: number;
  sampleHash: number;
  channelHash: number;
  /** Next frame index to read from the sample. */
  cursor: number;
  gain: number;
  /** Samples into the current/first render block before this voice begins
   *  (sub-block start offset). Consumed on render; decremented by a full
   *  blockSize when the voice is scheduled to start in a later block. */
  startOffset: number;
  active: boolean;
}

/**
 * Resolve a channel-hash to the stereo input bus (length blockSize*2,
 * interleaved) the voice should add into, or `undefined` when no such channel
 * exists this block (routing changed mid-flight).
 */
export type MixInto = (channelHash: number) => Float32Array | undefined;

export class AudioClipPlayer {
  private readonly samples = new Map<number, SampleData>();
  private voices: Voice[] = [];

  loadSample(sampleHash: number, pcm: Float32Array, channels: number, frames: number): void {
    this.samples.set(sampleHash, { pcm, channels, frames });
  }

  removeSample(sampleHash: number): void {
    this.samples.delete(sampleHash);
  }

  hasSample(sampleHash: number): boolean {
    return this.samples.has(sampleHash);
  }

  /** Count of currently-active voices (observability / tests). */
  get activeVoiceCount(): number {
    let n = 0;
    for (const v of this.voices) if (v.active) n++;
    return n;
  }

  startVoice(
    voiceId: number,
    sampleHash: number,
    channelHash: number,
    startFrame: number,
    gain: number,
    startOffset: number,
  ): void {
    this.voices.push({
      id: voiceId, sampleHash, channelHash,
      cursor: startFrame, gain, startOffset, active: true,
    });
  }

  /** Stop the voice with this id (idempotent; unknown ids are no-ops). */
  stopVoice(voiceId: number): void {
    for (const v of this.voices) {
      if (v.id === voiceId) v.active = false;
    }
  }

  /** Stop and drop every voice — transport stop / dispose. Samples are kept. */
  stopAll(): void {
    this.voices.length = 0;
  }

  render(blockSize: number, mixInto: MixInto): void {
    if (this.voices.length === 0) return;
    let anyDead = false;
    for (const v of this.voices) {
      if (!v.active) { anyDead = true; continue; }
      const s = this.samples.get(v.sampleHash);
      if (!s) { v.active = false; anyDead = true; continue; }

      // Voice scheduled to start in a later block — defer, no audio this block.
      if (v.startOffset >= blockSize) { v.startOffset -= blockSize; continue; }
      const start = v.startOffset > 0 ? v.startOffset : 0;
      v.startOffset = 0;

      const dest = mixInto(v.channelHash);
      const ch = s.channels;
      for (let i = start; i < blockSize; i++) {
        if (v.cursor >= s.frames) { v.active = false; anyDead = true; break; }
        const base = v.cursor * ch;
        const l = s.pcm[base]! * v.gain;
        const r = ch > 1 ? s.pcm[base + 1]! * v.gain : l;
        if (dest) {
          dest[i * 2]! += l;
          dest[i * 2 + 1]! += r;
        }
        v.cursor++;
      }
    }
    if (anyDead) this.voices = this.voices.filter((v) => v.active);
  }
}
