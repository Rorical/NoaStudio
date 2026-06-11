import { describe, it, expect, beforeEach } from 'vitest';
import {
  AudioClipScheduler,
  type AudioClipSchedulerDeps,
  type AudioSchedulerProject,
} from '../AudioClipScheduler';
import { decodeEvent, EVT_AUDIO_ON, EVT_AUDIO_OFF, type EngineEvent } from '../EngineEvent';
import { channelHash } from '../channelHash';

const SR = 48000;
const BPM = 120;
const SAMPLES_PER_BEAT = (SR * 60) / BPM; // 24000

function makeHarness(project: AudioSchedulerProject) {
  let current = 0;
  const events: EngineEvent[] = [];
  const deps: AudioClipSchedulerDeps = {
    sampleRate: SR,
    lookaheadSamples: Math.round(SR * 0.05), // 50 ms = 2400 samples
    readCurrentSample: () => current,
    pushEvent: (frame) => events.push(decodeEvent(frame)),
  };
  const sched = new AudioClipScheduler(deps);
  sched.setProject(project);
  return {
    sched,
    events,
    setSample: (s: number) => { current = s; },
  };
}

function audioProject(overrides: Partial<AudioSchedulerProject> = {}): AudioSchedulerProject {
  return {
    bpm: BPM,
    tracks: [{ id: 't8', channelId: 'm8', mute: false, solo: false }],
    clips: [{ trackId: 't8', start: 4, length: 4, sampleId: 's_demo' }],
    ...overrides,
  };
}

describe('AudioClipScheduler', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(audioProject()); });

  it('emits paired AudioOn/AudioOff for an audio clip entering the horizon', () => {
    h.sched.start({ startSample: 0, startBeat: 0 });
    h.setSample(SAMPLES_PER_BEAT * 4); // beat 4 — clip onset now in horizon
    h.sched.tick();
    const on = h.events.find((e) => e.type === EVT_AUDIO_ON);
    const off = h.events.find((e) => e.type === EVT_AUDIO_OFF);
    expect(on).toBeDefined();
    expect(off).toBeDefined();
    if (on?.type !== EVT_AUDIO_ON || off?.type !== EVT_AUDIO_OFF) throw new Error('types');
    expect(on.sampleHash).toBe(channelHash('s_demo'));
    expect(on.channelHash).toBe(channelHash('m8'));
    expect(on.startFrame).toBe(0);
    expect(on.gain).toBe(1);
    // onset at beat 4, off at beat 8
    expect(on.sampleTime).toBe(Math.round(4 * SAMPLES_PER_BEAT));
    expect(off.sampleTime).toBe(Math.round(8 * SAMPLES_PER_BEAT));
    // voiceIds pair up
    expect(off.voiceId).toBe(on.voiceId);
  });

  it('skips clips without a sampleId (MIDI / empty clips)', () => {
    h = makeHarness(audioProject({
      clips: [
        { trackId: 't8', start: 4, length: 4 }, // no sampleId
        { trackId: 't8', start: 4, length: 4, sampleId: 's_demo' },
      ],
    }));
    h.sched.start({ startSample: 0, startBeat: 0 });
    h.setSample(SAMPLES_PER_BEAT * 4);
    h.sched.tick();
    expect(h.events.filter((e) => e.type === EVT_AUDIO_ON)).toHaveLength(1);
  });

  it('does not re-emit a clip already scheduled (cursor advances)', () => {
    h.sched.start({ startSample: 0, startBeat: 0 });
    h.setSample(SAMPLES_PER_BEAT * 4);
    h.sched.tick();
    const firstCount = h.events.filter((e) => e.type === EVT_AUDIO_ON).length;
    h.setSample(SAMPLES_PER_BEAT * 5);
    h.sched.tick();
    expect(h.events.filter((e) => e.type === EVT_AUDIO_ON)).toHaveLength(firstCount);
  });

  it('only emits clips whose onset is within [cursor, horizon)', () => {
    h = makeHarness(audioProject({
      clips: [{ trackId: 't8', start: 64, length: 4, sampleId: 's_demo' }],
    }));
    h.sched.start({ startSample: 0, startBeat: 0 });
    h.setSample(0); // horizon ~0.1 beat, clip at beat 64 far away
    h.sched.tick();
    expect(h.events.filter((e) => e.type === EVT_AUDIO_ON)).toHaveLength(0);
  });

  it('respects track mute', () => {
    h = makeHarness(audioProject({
      tracks: [{ id: 't8', channelId: 'm8', mute: true, solo: false }],
    }));
    h.sched.start({ startSample: 0, startBeat: 0 });
    h.setSample(SAMPLES_PER_BEAT * 4);
    h.sched.tick();
    expect(h.events.filter((e) => e.type === EVT_AUDIO_ON)).toHaveLength(0);
  });

  it('solo isolates the soloed track', () => {
    h = makeHarness(audioProject({
      tracks: [
        { id: 't8', channelId: 'm8', mute: false, solo: false },
        { id: 't9', channelId: 'm9', mute: false, solo: true },
      ],
      clips: [
        { trackId: 't8', start: 4, length: 4, sampleId: 's_a' },
        { trackId: 't9', start: 4, length: 4, sampleId: 's_b' },
      ],
    }));
    h.sched.start({ startSample: 0, startBeat: 0 });
    h.setSample(SAMPLES_PER_BEAT * 4);
    h.sched.tick();
    const ons = h.events.filter((e) => e.type === EVT_AUDIO_ON);
    expect(ons).toHaveLength(1);
    if (ons[0]?.type === EVT_AUDIO_ON) expect(ons[0].channelHash).toBe(channelHash('m9'));
  });

  it('stop() emits an immediate AudioOff for still-playing voices and clears them', () => {
    h.sched.start({ startSample: 0, startBeat: 0 });
    h.setSample(SAMPLES_PER_BEAT * 4);
    h.sched.tick();
    const on = h.events.find((e) => e.type === EVT_AUDIO_ON);
    if (on?.type !== EVT_AUDIO_ON) throw new Error('no on');
    h.events.length = 0;
    // current sample still before the scheduled off (beat 8) -> voice active
    h.setSample(SAMPLES_PER_BEAT * 5);
    h.sched.stop();
    const off = h.events.find((e) => e.type === EVT_AUDIO_OFF);
    expect(off).toBeDefined();
    if (off?.type !== EVT_AUDIO_OFF) throw new Error('no off');
    expect(off.voiceId).toBe(on.voiceId);
    expect(off.sampleTime).toBe(0); // immediate
  });

  it('stop() does not re-off voices whose off has already passed', () => {
    h.sched.start({ startSample: 0, startBeat: 0 });
    h.setSample(SAMPLES_PER_BEAT * 4);
    h.sched.tick();
    h.events.length = 0;
    h.setSample(SAMPLES_PER_BEAT * 100); // way past the off at beat 8
    h.sched.stop();
    expect(h.events.filter((e) => e.type === EVT_AUDIO_OFF)).toHaveLength(0);
  });

  it('reset() re-anchors so clips after a loop wrap re-emit', () => {
    h.sched.start({ startSample: 0, startBeat: 0 });
    h.setSample(SAMPLES_PER_BEAT * 4);
    h.sched.tick();
    const before = h.events.filter((e) => e.type === EVT_AUDIO_ON).length;
    expect(before).toBe(1);
    // Loop wraps back to beat 0.
    h.setSample(0);
    h.sched.reset({ startSample: 0, startBeat: 0 });
    h.setSample(SAMPLES_PER_BEAT * 4);
    h.sched.tick();
    expect(h.events.filter((e) => e.type === EVT_AUDIO_ON)).toHaveLength(before + 1);
  });

  it('is inert before start() and after stop()', () => {
    h.setSample(SAMPLES_PER_BEAT * 4);
    h.sched.tick(); // never started
    expect(h.events).toHaveLength(0);
    h.sched.start({ startSample: 0, startBeat: 0 });
    h.sched.stop();
    h.sched.tick();
    expect(h.events.filter((e) => e.type === EVT_AUDIO_ON)).toHaveLength(0);
  });

  it('passes a per-clip gain through to AudioOn', () => {
    h = makeHarness(audioProject({
      clips: [{ trackId: 't8', start: 4, length: 4, sampleId: 's_demo', gain: 0.5 }],
    }));
    h.sched.start({ startSample: 0, startBeat: 0 });
    h.setSample(SAMPLES_PER_BEAT * 4);
    h.sched.tick();
    const on = h.events.find((e) => e.type === EVT_AUDIO_ON);
    if (on?.type !== EVT_AUDIO_ON) throw new Error('no on');
    expect(on.gain).toBe(0.5);
  });
});
