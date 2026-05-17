import {
  EVT_NOTE_ON, EVT_NOTE_OFF,
  type EngineEvent,
} from '../EngineEvent';

const MAX_VOICES = 8;
const RELEASE_PER_SAMPLE = 1e-3;
const MASTER_TRIM = 0.5;

interface Voice {
  active: boolean;
  releasing: boolean;
  note: number;
  freq: number;
  phase: number;
  amp: number;
}

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function makeVoice(): Voice {
  return { active: false, releasing: false, note: 0, freq: 0, phase: 0, amp: 0 };
}

export class SineGenerator {
  private readonly voices: Voice[] = Array.from({ length: MAX_VOICES }, makeVoice);
  private readonly sampleRate: number;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  process(events: readonly EngineEvent[], output: Float32Array): void {
    const blockSize = output.length;
    let eventIdx = 0;

    for (let i = 0; i < blockSize; i++) {
      while (eventIdx < events.length && events[eventIdx]!.frameOffset <= i) {
        this.applyEvent(events[eventIdx]!);
        eventIdx++;
      }

      let sample = 0;
      for (let vi = 0; vi < MAX_VOICES; vi++) {
        const v = this.voices[vi]!;
        if (!v.active) continue;
        sample += Math.sin(v.phase * Math.PI * 2) * v.amp;
        v.phase += v.freq / this.sampleRate;
        if (v.phase >= 1) v.phase -= 1;
        if (v.releasing) {
          v.amp -= RELEASE_PER_SAMPLE;
          if (v.amp <= 0) {
            v.active = false;
            v.releasing = false;
            v.amp = 0;
          }
        }
      }
      output[i] = sample * MASTER_TRIM;
    }

    // Drain any remaining events at or beyond blockSize (rare, but possible
    // if the producer queued a future-offset event).
    while (eventIdx < events.length) {
      this.applyEvent(events[eventIdx]!);
      eventIdx++;
    }
  }

  private applyEvent(ev: EngineEvent): void {
    if (ev.type === EVT_NOTE_ON) {
      const slot =
        this.voices.find((v) => !v.active) ??
        this.voices[0]!;
      slot.active = true;
      slot.releasing = false;
      slot.note = ev.note;
      slot.freq = midiToFreq(ev.note);
      slot.amp = (ev.velocity / 127);
      slot.phase = 0;
    } else if (ev.type === EVT_NOTE_OFF) {
      for (const v of this.voices) {
        if (v.active && v.note === ev.note) v.releasing = true;
      }
    }
    // All other event types are ignored at this layer.
  }
}
