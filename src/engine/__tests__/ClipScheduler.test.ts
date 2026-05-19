import { describe, it, expect } from 'vitest';
import { ClipScheduler, type ClipSchedulerProject } from '../ClipScheduler';
import {
  EVENT_FRAME_SIZE, decodeEvent, EVT_NOTE_ON, EVT_NOTE_OFF,
} from '../EngineEvent';

const SAMPLE_RATE = 48000;
const BPM = 120;
const SAMPLES_PER_BEAT = SAMPLE_RATE * 60 / BPM; // 24000

interface FakeEvent {
  type: number;
  sampleTime: number;
  targetId: number;
  note: number;
}

function decode(frames: Uint8Array[]): FakeEvent[] {
  return frames.map((f) => {
    const ev = decodeEvent(f);
    return {
      type: ev.type,
      sampleTime: ev.sampleTime,
      // @ts-expect-error narrow at runtime
      targetId: ev.targetId,
      // @ts-expect-error narrow at runtime
      note: ev.note,
    };
  });
}

function makeScheduler(opts?: { lookaheadSamples?: number }) {
  const events: Uint8Array[] = [];
  let currentSample = 0;
  const sched = new ClipScheduler({
    sampleRate: SAMPLE_RATE,
    lookaheadSamples: opts?.lookaheadSamples ?? SAMPLES_PER_BEAT,
    readCurrentSample: () => currentSample,
    pushEvent: (frame) => {
      const copy = new Uint8Array(EVENT_FRAME_SIZE);
      copy.set(frame);
      events.push(copy);
    },
  });
  return {
    sched,
    events,
    setSample(s: number) { currentSample = s; },
  };
}

function singleNoteProject(): ClipSchedulerProject {
  return {
    bpm: BPM,
    tracks: [
      { id: 't1', mute: false, solo: false, generatorNumericId: 7 },
    ],
    clips: [
      {
        trackId: 't1', start: 0, length: 4,
        pattern: { notes: [[1, 60, 0.5]] },
      },
    ],
  };
}

describe('ClipScheduler — idle behaviour', () => {
  it('emits nothing before start() is called', () => {
    const { sched, events } = makeScheduler();
    sched.setProject(singleNoteProject());
    sched.tick();
    expect(events).toHaveLength(0);
  });

  it('emits nothing after stop()', () => {
    const { sched, events, setSample } = makeScheduler();
    sched.setProject(singleNoteProject());
    sched.start({ startSample: 0, startBeat: 0 });
    sched.stop();
    setSample(SAMPLES_PER_BEAT * 2);
    sched.tick();
    expect(events).toHaveLength(0);
  });
});

describe('ClipScheduler — single note emission', () => {
  it('emits paired NoteOn/NoteOff at the right sample times', () => {
    const { sched, events, setSample } = makeScheduler({
      lookaheadSamples: SAMPLES_PER_BEAT * 2,
    });
    sched.setProject(singleNoteProject());
    sched.start({ startSample: 0, startBeat: 0 });
    setSample(0);
    sched.tick();
    const decoded = decode(events);
    expect(decoded.length).toBe(2);
    const on = decoded.find((e) => e.type === EVT_NOTE_ON)!;
    const off = decoded.find((e) => e.type === EVT_NOTE_OFF)!;
    expect(on.note).toBe(60);
    expect(on.targetId).toBe(7);
    expect(on.sampleTime).toBe(SAMPLES_PER_BEAT); // note onset at beat 1
    expect(off.sampleTime).toBe(SAMPLES_PER_BEAT + SAMPLES_PER_BEAT * 0.5);
  });

  it('does not re-emit notes on subsequent ticks', () => {
    const { sched, events, setSample } = makeScheduler({
      lookaheadSamples: SAMPLES_PER_BEAT * 4,
    });
    sched.setProject(singleNoteProject());
    sched.start({ startSample: 0, startBeat: 0 });
    setSample(0);
    sched.tick();
    const before = events.length;
    setSample(100);
    sched.tick();
    sched.tick();
    expect(events.length).toBe(before);
  });
});

describe('ClipScheduler — lookahead window', () => {
  it('only emits notes inside the lookahead horizon', () => {
    const { sched, events, setSample } = makeScheduler({
      lookaheadSamples: SAMPLES_PER_BEAT / 2, // half a beat ahead
    });
    sched.setProject({
      bpm: BPM,
      tracks: [{ id: 't1', mute: false, solo: false, generatorNumericId: 1 }],
      clips: [{
        trackId: 't1', start: 0, length: 4,
        pattern: { notes: [[0.1, 60, 0.1], [2, 64, 0.1]] }, // 2nd note way past horizon
      }],
    });
    sched.start({ startSample: 0, startBeat: 0 });
    setSample(0);
    sched.tick();
    const ons = decode(events).filter((e) => e.type === EVT_NOTE_ON);
    expect(ons.map((e) => e.note)).toEqual([60]);
  });

  it('emits the second note on a later tick once it falls in horizon', () => {
    const { sched, events, setSample } = makeScheduler({
      lookaheadSamples: SAMPLES_PER_BEAT / 2,
    });
    sched.setProject({
      bpm: BPM,
      tracks: [{ id: 't1', mute: false, solo: false, generatorNumericId: 1 }],
      clips: [{
        trackId: 't1', start: 0, length: 4,
        pattern: { notes: [[0.1, 60, 0.1], [2, 64, 0.1]] },
      }],
    });
    sched.start({ startSample: 0, startBeat: 0 });
    setSample(SAMPLES_PER_BEAT * 1.8); // beat ~1.8, lookahead reaches beat 2.3
    sched.tick();
    const ons = decode(events).filter((e) => e.type === EVT_NOTE_ON);
    expect(ons.map((e) => e.note).sort()).toEqual([60, 64]);
  });
});

describe('ClipScheduler — track filtering', () => {
  it('skips muted tracks', () => {
    const { sched, events, setSample } = makeScheduler({
      lookaheadSamples: SAMPLES_PER_BEAT * 4,
    });
    const p = singleNoteProject();
    p.tracks[0]!.mute = true;
    sched.setProject(p);
    sched.start({ startSample: 0, startBeat: 0 });
    setSample(0);
    sched.tick();
    expect(events).toHaveLength(0);
  });

  it('when any track is soloed, plays only that track', () => {
    const { sched, events, setSample } = makeScheduler({
      lookaheadSamples: SAMPLES_PER_BEAT * 4,
    });
    sched.setProject({
      bpm: BPM,
      tracks: [
        { id: 't1', mute: false, solo: false, generatorNumericId: 1 },
        { id: 't2', mute: false, solo: true, generatorNumericId: 2 },
      ],
      clips: [
        { trackId: 't1', start: 0, length: 4, pattern: { notes: [[0, 60, 1]] } },
        { trackId: 't2', start: 0, length: 4, pattern: { notes: [[0, 64, 1]] } },
      ],
    });
    sched.start({ startSample: 0, startBeat: 0 });
    setSample(0);
    sched.tick();
    const ons = decode(events).filter((e) => e.type === EVT_NOTE_ON);
    expect(ons.map((e) => e.targetId)).toEqual([2]);
  });

  it('skips tracks that have no generator', () => {
    const { sched, events, setSample } = makeScheduler({
      lookaheadSamples: SAMPLES_PER_BEAT * 4,
    });
    sched.setProject({
      bpm: BPM,
      tracks: [{ id: 't1', mute: false, solo: false }],
      clips: [{ trackId: 't1', start: 0, length: 4, pattern: { notes: [[0, 60, 1]] } }],
    });
    sched.start({ startSample: 0, startBeat: 0 });
    setSample(0);
    sched.tick();
    expect(events).toHaveLength(0);
  });
});

describe('ClipScheduler — stop releases ringing notes', () => {
  it('emits an immediate NoteOff for any note whose offSampleTime is still in the future', () => {
    const { sched, events, setSample } = makeScheduler({
      lookaheadSamples: SAMPLES_PER_BEAT * 2,
    });
    sched.setProject({
      bpm: BPM,
      tracks: [{ id: 't1', mute: false, solo: false, generatorNumericId: 9 }],
      // Single long note: onset beat 0, length 4 beats → NoteOff at sample 4*samplesPerBeat
      clips: [{ trackId: 't1', start: 0, length: 4, pattern: { notes: [[0, 60, 4]] } }],
    });
    sched.start({ startSample: 0, startBeat: 0 });
    setSample(0);
    sched.tick();
    const onsBefore = decode(events).filter((e) => e.type === EVT_NOTE_ON).length;
    const offsBefore = decode(events).filter((e) => e.type === EVT_NOTE_OFF).length;
    expect(onsBefore).toBe(1);
    expect(offsBefore).toBe(1); // the paired (future) NoteOff
    // Stop mid-note (well before the paired NoteOff's sample time).
    setSample(SAMPLES_PER_BEAT); // beat 1, NoteOff is at beat 4
    sched.stop();
    const offsAfter = decode(events).filter((e) => e.type === EVT_NOTE_OFF);
    expect(offsAfter).toHaveLength(2); // the original future one + the immediate panic
    // The new NoteOff has sampleTime 0 ("fire immediately").
    expect(offsAfter[1]!.sampleTime).toBe(0);
    expect(offsAfter[1]!.note).toBe(60);
    expect(offsAfter[1]!.targetId).toBe(9);
  });

  it('emits no extra NoteOff when the paired NoteOff has already passed', () => {
    const { sched, events, setSample } = makeScheduler({
      lookaheadSamples: SAMPLES_PER_BEAT * 2,
    });
    sched.setProject({
      bpm: BPM,
      tracks: [{ id: 't1', mute: false, solo: false, generatorNumericId: 9 }],
      clips: [{ trackId: 't1', start: 0, length: 4, pattern: { notes: [[0, 60, 0.5]] } }],
    });
    sched.start({ startSample: 0, startBeat: 0 });
    setSample(0);
    sched.tick();
    const offsBefore = decode(events).filter((e) => e.type === EVT_NOTE_OFF).length;
    // Stop AFTER the NoteOff would have fired (sample 0.5 × samplesPerBeat).
    setSample(SAMPLES_PER_BEAT);
    sched.stop();
    const offsAfter = decode(events).filter((e) => e.type === EVT_NOTE_OFF);
    expect(offsAfter).toHaveLength(offsBefore); // no extras
  });
});

describe('ClipScheduler — reset (loop wrap)', () => {
  it('reset re-schedules notes from a given beat', () => {
    const { sched, events, setSample } = makeScheduler({
      lookaheadSamples: SAMPLES_PER_BEAT * 4,
    });
    sched.setProject(singleNoteProject());
    sched.start({ startSample: 0, startBeat: 0 });
    setSample(0);
    sched.tick();
    const before = events.length;
    // Simulate a loop wrap: caller resets the cursor and updates the anchor.
    sched.reset({ startSample: SAMPLES_PER_BEAT * 10, startBeat: 0 });
    setSample(SAMPLES_PER_BEAT * 10);
    sched.tick();
    // The same note should be emitted again, with samples shifted by the new anchor.
    const after = events.length;
    expect(after).toBeGreaterThan(before);
  });
});
