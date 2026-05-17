import { describe, it, expect } from 'vitest';
import { applyAction } from '../reducer';
import { seedProject, type Project } from '../projectModel';
import type { Action } from '../actions';

function run(state: Project, action: Action) {
  return applyAction(state, action);
}

describe('reducer — clips', () => {
  it('MOVE_CLIP changes start', () => {
    const s0 = seedProject();
    const [s1] = run(s0, { type: 'MOVE_CLIP', clipId: 'c1', start: 8 });
    expect(s1.clips.find((c) => c.id === 'c1')!.start).toBe(8);
  });

  it('MOVE_CLIP with unknown id is a no-op', () => {
    const s0 = seedProject();
    const [s1, patches] = run(s0, { type: 'MOVE_CLIP', clipId: 'nope', start: 99 });
    expect(s1).toBe(s0);
    expect(patches.length).toBe(0);
  });

  it('UPDATE_CLIP_NOTES replaces pattern.notes', () => {
    const s0 = seedProject();
    const notes: [number, number, number][] = [[0, 60, 1], [1, 64, 1]];
    const [s1] = run(s0, { type: 'UPDATE_CLIP_NOTES', clipId: 'c20', notes });
    expect(s1.clips.find((c) => c.id === 'c20')!.pattern!.notes).toEqual(notes);
  });

  it('UPDATE_CLIP_LENGTH only grows, never shrinks', () => {
    const s0 = seedProject();
    const c1 = s0.clips.find((c) => c.id === 'c1')!;
    const orig = c1.length;
    const [s1] = run(s0, { type: 'UPDATE_CLIP_LENGTH', clipId: 'c1', length: orig - 1 });
    expect(s1.clips.find((c) => c.id === 'c1')!.length).toBe(orig);
    const [s2] = run(s0, { type: 'UPDATE_CLIP_LENGTH', clipId: 'c1', length: orig + 4 });
    expect(s2.clips.find((c) => c.id === 'c1')!.length).toBe(orig + 4);
  });
});

describe('reducer — tracks (with channel cascade)', () => {
  it('TOGGLE_TRACK_MUTE toggles track AND its channel', () => {
    const s0 = seedProject();
    const t1 = s0.tracks.find((t) => t.id === 't1')!;
    const ch = s0.channels.find((c) => c.id === 'm' + t1.channel)!;
    const [s1] = run(s0, { type: 'TOGGLE_TRACK_MUTE', trackId: 't1' });
    expect(s1.tracks.find((t) => t.id === 't1')!.mute).toBe(!t1.mute);
    expect(s1.channels.find((c) => c.id === 'm' + t1.channel)!.mute).toBe(!ch.mute);
  });

  it('TOGGLE_TRACK_SOLO toggles track AND its channel', () => {
    const s0 = seedProject();
    const t1 = s0.tracks.find((t) => t.id === 't1')!;
    const [s1] = run(s0, { type: 'TOGGLE_TRACK_SOLO', trackId: 't1' });
    expect(s1.tracks.find((t) => t.id === 't1')!.solo).toBe(!t1.solo);
    expect(s1.channels.find((c) => c.id === 'm' + t1.channel)!.solo).toBe(!t1.solo);
  });

  it('ASSIGN_GENERATOR sets generator and forces type to midi', () => {
    const s0 = seedProject();
    const [s1] = run(s0, { type: 'ASSIGN_GENERATOR', trackId: 't8', generator: 'Pigments' });
    const t8 = s1.tracks.find((t) => t.id === 't8')!;
    expect(t8.generator).toBe('Pigments');
    expect(t8.type).toBe('midi');
  });
});

describe('reducer — channels', () => {
  it('SET_FADER updates vol', () => {
    const s0 = seedProject();
    const [s1] = run(s0, { type: 'SET_FADER', channelId: 'm1', value: 0.31 });
    expect(s1.channels.find((c) => c.id === 'm1')!.vol).toBeCloseTo(0.31);
  });

  it('SET_PAN updates pan', () => {
    const s0 = seedProject();
    const [s1] = run(s0, { type: 'SET_PAN', channelId: 'm1', value: -0.4 });
    expect(s1.channels.find((c) => c.id === 'm1')!.pan).toBeCloseTo(-0.4);
  });

  it('TOGGLE_CHANNEL_MUTE / SOLO toggle the channel only', () => {
    const s0 = seedProject();
    const m1Before = s0.channels.find((c) => c.id === 'm1')!;
    const [s1] = run(s0, { type: 'TOGGLE_CHANNEL_MUTE', channelId: 'm1' });
    expect(s1.channels.find((c) => c.id === 'm1')!.mute).toBe(!m1Before.mute);
    const [s2] = run(s0, { type: 'TOGGLE_CHANNEL_SOLO', channelId: 'm1' });
    expect(s2.channels.find((c) => c.id === 'm1')!.solo).toBe(!m1Before.solo);
  });
});

describe('reducer — effects', () => {
  it('ADD_EFFECT appends to channel.effects', () => {
    const s0 = seedProject();
    const before = s0.channels.find((c) => c.id === 'm1')!.effects.length;
    const [s1] = run(s0, {
      type: 'ADD_EFFECT',
      channelId: 'm1',
      effect: { id: 'eX', name: 'Chorus', kind: 'fx', bypass: false },
    });
    const after = s1.channels.find((c) => c.id === 'm1')!.effects;
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]!.id).toBe('eX');
  });

  it('REMOVE_EFFECT filters by id', () => {
    const s0 = seedProject();
    const m1 = s0.channels.find((c) => c.id === 'm1')!;
    const victimId = m1.effects[0]!.id;
    const [s1] = run(s0, { type: 'REMOVE_EFFECT', channelId: 'm1', effectId: victimId });
    expect(s1.channels.find((c) => c.id === 'm1')!.effects.find((e) => e.id === victimId)).toBeUndefined();
  });

  it('BYPASS_EFFECT toggles bypass on the matching effect', () => {
    const s0 = seedProject();
    const m1 = s0.channels.find((c) => c.id === 'm1')!;
    const target = m1.effects[0]!;
    const [s1] = run(s0, { type: 'BYPASS_EFFECT', channelId: 'm1', effectId: target.id });
    expect(s1.channels.find((c) => c.id === 'm1')!.effects.find((e) => e.id === target.id)!.bypass)
      .toBe(!target.bypass);
  });
});

describe('reducer — project settings', () => {
  it('SET_BPM updates bpm', () => {
    const s0 = seedProject();
    const [s1] = run(s0, { type: 'SET_BPM', bpm: 140 });
    expect(s1.bpm).toBe(140);
  });

  it('TOGGLE_LOOP flips loop', () => {
    const s0 = seedProject();
    const [s1] = run(s0, { type: 'TOGGLE_LOOP' });
    expect(s1.loop).toBe(!s0.loop);
  });

  it('TOGGLE_METRONOME flips metronome', () => {
    const s0 = seedProject();
    const [s1] = run(s0, { type: 'TOGGLE_METRONOME' });
    expect(s1.metronome).toBe(!s0.metronome);
  });
});

describe('reducer — patches', () => {
  it('returns Immer-shaped patches and inverse patches', () => {
    const s0 = seedProject();
    const [, patches, inverse] = run(s0, { type: 'SET_BPM', bpm: 999 });
    expect(patches.length).toBe(1);
    expect(patches[0]!.op).toBe('replace');
    expect(patches[0]!.path).toEqual(['bpm']);
    expect(patches[0]!.value).toBe(999);
    expect(inverse.length).toBe(1);
    expect(inverse[0]!.value).toBe(124);
  });

  it('no-op actions return empty patches', () => {
    const s0 = seedProject();
    const [s1, patches, inverse] = run(s0, { type: 'MOVE_CLIP', clipId: 'nope', start: 1 });
    expect(s1).toBe(s0);
    expect(patches).toEqual([]);
    expect(inverse).toEqual([]);
  });
});
