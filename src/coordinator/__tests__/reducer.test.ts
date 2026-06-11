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

  it('SET_CLIP_LENGTH supports both growing and shrinking', () => {
    const s0 = seedProject();
    const c1 = s0.clips.find((c) => c.id === 'c1')!;
    const orig = c1.length;
    const [s1] = run(s0, { type: 'SET_CLIP_LENGTH', clipId: 'c1', length: orig + 4 });
    expect(s1.clips.find((c) => c.id === 'c1')!.length).toBe(orig + 4);
    const [s2] = run(s1, { type: 'SET_CLIP_LENGTH', clipId: 'c1', length: 1 });
    expect(s2.clips.find((c) => c.id === 'c1')!.length).toBe(1);
  });

  it('SET_CLIP_LENGTH clamps to a minimum of 0.25 beats', () => {
    const s0 = seedProject();
    const [s1] = run(s0, { type: 'SET_CLIP_LENGTH', clipId: 'c1', length: 0 });
    expect(s1.clips.find((c) => c.id === 'c1')!.length).toBe(0.25);
    const [s2] = run(s0, { type: 'SET_CLIP_LENGTH', clipId: 'c1', length: -5 });
    expect(s2.clips.find((c) => c.id === 'c1')!.length).toBe(0.25);
  });

  it('SET_CLIP_LENGTH is a no-op when the length is unchanged', () => {
    const s0 = seedProject();
    const c1 = s0.clips.find((c) => c.id === 'c1')!;
    const [s1, patches] = run(s0, { type: 'SET_CLIP_LENGTH', clipId: 'c1', length: c1.length });
    expect(s1).toBe(s0);
    expect(patches).toEqual([]);
  });

  it('SET_CLIP_LENGTH on unknown clip is a no-op', () => {
    const s0 = seedProject();
    const [s1, patches] = run(s0, { type: 'SET_CLIP_LENGTH', clipId: 'cZZ', length: 8 });
    expect(s1).toBe(s0);
    expect(patches).toEqual([]);
  });

  it('DELETE_CLIP removes the clip from the clips array', () => {
    const s0 = seedProject();
    const before = s0.clips.length;
    const [s1] = run(s0, { type: 'DELETE_CLIP', clipId: 'c1' });
    expect(s1.clips).toHaveLength(before - 1);
    expect(s1.clips.find((c) => c.id === 'c1')).toBeUndefined();
  });

  it('DELETE_CLIP on unknown clip is a no-op', () => {
    const s0 = seedProject();
    const [s1, patches] = run(s0, { type: 'DELETE_CLIP', clipId: 'cZZ' });
    expect(s1).toBe(s0);
    expect(patches).toEqual([]);
  });

  it('DUPLICATE_CLIP appends a copy at start+length with a new id', () => {
    const s0 = seedProject();
    const c1 = s0.clips.find((c) => c.id === 'c1')!;
    const before = s0.clips.length;
    const [s1] = run(s0, { type: 'DUPLICATE_CLIP', clipId: 'c1', newId: 'c_dup' });
    expect(s1.clips).toHaveLength(before + 1);
    const dup = s1.clips.find((c) => c.id === 'c_dup')!;
    expect(dup.trackId).toBe(c1.trackId);
    expect(dup.start).toBe(c1.start + c1.length);
    expect(dup.length).toBe(c1.length);
    // Original is untouched.
    expect(s1.clips.find((c) => c.id === 'c1')!.start).toBe(c1.start);
  });

  it('DUPLICATE_CLIP deep-clones the pattern.notes array', () => {
    const s0 = seedProject();
    const c1 = s0.clips.find((c) => c.id === 'c1')!;
    expect(c1.pattern).toBeDefined();
    const [s1] = run(s0, { type: 'DUPLICATE_CLIP', clipId: 'c1', newId: 'c_dup' });
    const dup = s1.clips.find((c) => c.id === 'c_dup')!;
    expect(dup.pattern!.notes).toEqual(c1.pattern!.notes);
    expect(dup.pattern!.notes).not.toBe(c1.pattern!.notes);
    // Each note tuple is a fresh array too.
    expect(dup.pattern!.notes[0]).not.toBe(c1.pattern!.notes[0]);
  });

  it('DUPLICATE_CLIP on unknown clip is a no-op', () => {
    const s0 = seedProject();
    const [s1, patches] = run(s0, { type: 'DUPLICATE_CLIP', clipId: 'cZZ' });
    expect(s1).toBe(s0);
    expect(patches).toEqual([]);
  });

  it('SET_CLIP_LABEL renames a clip', () => {
    const s0 = seedProject();
    const [s1] = run(s0, { type: 'SET_CLIP_LABEL', clipId: 'c1', label: 'New label' });
    expect(s1.clips.find((c) => c.id === 'c1')!.label).toBe('New label');
  });

  it('SET_CLIP_LABEL trims whitespace', () => {
    const s0 = seedProject();
    const [s1] = run(s0, { type: 'SET_CLIP_LABEL', clipId: 'c1', label: '  Padded  ' });
    expect(s1.clips.find((c) => c.id === 'c1')!.label).toBe('Padded');
  });

  it('SET_CLIP_LABEL rejects empty / whitespace-only labels', () => {
    const s0 = seedProject();
    const [s1, patches] = run(s0, { type: 'SET_CLIP_LABEL', clipId: 'c1', label: '   ' });
    expect(s1).toBe(s0);
    expect(patches).toEqual([]);
  });

  it('SET_CLIP_LABEL is a no-op when the label is unchanged', () => {
    const s0 = seedProject();
    const orig = s0.clips.find((c) => c.id === 'c1')!.label;
    const [s1, patches] = run(s0, { type: 'SET_CLIP_LABEL', clipId: 'c1', label: orig });
    expect(s1).toBe(s0);
    expect(patches).toEqual([]);
  });

  it('SET_CLIP_LABEL on unknown clip is a no-op', () => {
    const s0 = seedProject();
    const [s1, patches] = run(s0, { type: 'SET_CLIP_LABEL', clipId: 'cZZ', label: 'X' });
    expect(s1).toBe(s0);
    expect(patches).toEqual([]);
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
});

describe('reducer — SET_TRACK_NAME', () => {
  it('renames a track', () => {
    const s0 = seedProject();
    const [s1] = run(s0, { type: 'SET_TRACK_NAME', trackId: 't1', name: 'Bass Drum' });
    expect(s1.tracks.find((t) => t.id === 't1')!.name).toBe('Bass Drum');
  });

  it('trims whitespace', () => {
    const s0 = seedProject();
    const [s1] = run(s0, { type: 'SET_TRACK_NAME', trackId: 't1', name: '  Boom  ' });
    expect(s1.tracks.find((t) => t.id === 't1')!.name).toBe('Boom');
  });

  it('rejects empty/whitespace names', () => {
    const s0 = seedProject();
    const [s1, patches] = run(s0, { type: 'SET_TRACK_NAME', trackId: 't1', name: '  ' });
    expect(s1).toBe(s0);
    expect(patches).toEqual([]);
  });

  it('is a no-op when the name is unchanged', () => {
    const s0 = seedProject();
    const orig = s0.tracks.find((t) => t.id === 't1')!.name;
    const [s1, patches] = run(s0, { type: 'SET_TRACK_NAME', trackId: 't1', name: orig });
    expect(s1).toBe(s0);
    expect(patches).toEqual([]);
  });

  it('is a no-op for unknown trackId', () => {
    const s0 = seedProject();
    const [s1, patches] = run(s0, { type: 'SET_TRACK_NAME', trackId: 'tZZ', name: 'X' });
    expect(s1).toBe(s0);
    expect(patches).toEqual([]);
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

describe('reducer — plugin instances', () => {
  it('LOAD_PLUGIN onto a channel FX rack appends an instance', () => {
    const s0 = seedProject();
    const before = s0.channels.find((c) => c.id === 'm1')!.effects.length;
    const [s1] = run(s0, {
      type: 'LOAD_PLUGIN',
      pluginId: 'com.noa.gain',
      target: { kind: 'channel-fx', channelId: 'm1' },
      defaults: [1.0],
    });
    const after = s1.channels.find((c) => c.id === 'm1')!.effects;
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]!.pluginId).toBe('com.noa.gain');
    expect(after[after.length - 1]!.params).toEqual([1.0]);
    expect(after[after.length - 1]!.bypass).toBe(false);
  });

  it('LOAD_PLUGIN with insertAt inserts at the given position', () => {
    const s0 = seedProject();
    const [s1] = run(s0, {
      type: 'LOAD_PLUGIN',
      pluginId: 'com.noa.gain',
      target: { kind: 'channel-fx', channelId: 'm0', insertAt: 0 },
      defaults: [0.5],
      instanceId: 'i_test',
    });
    const effects = s1.channels.find((c) => c.id === 'm0')!.effects;
    expect(effects[0]!.id).toBe('i_test');
    expect(effects[0]!.pluginId).toBe('com.noa.gain');
  });

  it('LOAD_PLUGIN onto a track-generator slot replaces the previous generator', () => {
    const s0 = seedProject();
    const [s1] = run(s0, {
      type: 'LOAD_PLUGIN',
      pluginId: 'com.noa.sine',
      target: { kind: 'track-generator', trackId: 't4' },
      defaults: [0.5, 0],
      instanceId: 'i_new',
    });
    const t4 = s1.tracks.find((t) => t.id === 't4')!;
    expect(t4.generator?.id).toBe('i_new');
    expect(t4.generator?.pluginId).toBe('com.noa.sine');
    expect(t4.type).toBe('midi');
  });

  it('LOAD_PLUGIN onto unknown channel is a no-op', () => {
    const s0 = seedProject();
    const [s1, patches] = run(s0, {
      type: 'LOAD_PLUGIN',
      pluginId: 'com.noa.gain',
      target: { kind: 'channel-fx', channelId: 'mZZ' },
      defaults: [1],
    });
    expect(s1).toBe(s0);
    expect(patches.length).toBe(0);
  });

  it('UNLOAD_PLUGIN removes a channel effect', () => {
    const s0 = seedProject();
    const target = s0.channels.find((c) => c.id === 'm0')!.effects[0]!;
    const [s1] = run(s0, { type: 'UNLOAD_PLUGIN', instanceId: target.id });
    expect(s1.channels.find((c) => c.id === 'm0')!.effects).toHaveLength(0);
  });

  it('UNLOAD_PLUGIN clears a track generator', () => {
    const s0 = seedProject();
    const inst = s0.tracks.find((t) => t.id === 't1')!.generator!;
    const [s1] = run(s0, { type: 'UNLOAD_PLUGIN', instanceId: inst.id });
    expect(s1.tracks.find((t) => t.id === 't1')!.generator).toBeNull();
  });

  it('UNLOAD_PLUGIN with unknown id is a no-op', () => {
    const s0 = seedProject();
    const [s1, patches] = run(s0, { type: 'UNLOAD_PLUGIN', instanceId: 'i_nope' });
    expect(s1).toBe(s0);
    expect(patches.length).toBe(0);
  });

  it('SET_PARAM updates a param on a channel effect', () => {
    const s0 = seedProject();
    const inst = s0.channels.find((c) => c.id === 'm0')!.effects[0]!;
    // Hydrate the params slot so SET_PARAM has somewhere to write.
    const [s1] = run(s0, {
      type: 'LOAD_PLUGIN',
      pluginId: 'com.noa.gain',
      target: { kind: 'channel-fx', channelId: 'm1' },
      defaults: [1.0],
      instanceId: 'i_p1',
    });
    const [s2] = run(s1, { type: 'SET_PARAM', instanceId: 'i_p1', paramIndex: 0, value: 0.25 });
    const fx = s2.channels.find((c) => c.id === 'm1')!.effects.find((e) => e.id === 'i_p1')!;
    expect(fx.params[0]).toBe(0.25);
    // The original seed instance is untouched.
    expect(s2.channels.find((c) => c.id === 'm0')!.effects[0]!.id).toBe(inst.id);
  });

  it('SET_PARAM updates a param on a track generator', () => {
    const s0 = seedProject();
    const [s1] = run(s0, {
      type: 'LOAD_PLUGIN',
      pluginId: 'com.noa.sine',
      target: { kind: 'track-generator', trackId: 't2' },
      defaults: [0.5, 0],
      instanceId: 'i_g2',
    });
    const [s2] = run(s1, { type: 'SET_PARAM', instanceId: 'i_g2', paramIndex: 1, value: 2 });
    const t2 = s2.tracks.find((t) => t.id === 't2')!;
    expect(t2.generator!.params).toEqual([0.5, 2]);
  });

  it('SET_PARAM with unknown instance is a no-op', () => {
    const s0 = seedProject();
    const [s1, patches] = run(s0, {
      type: 'SET_PARAM', instanceId: 'i_nope', paramIndex: 0, value: 0,
    });
    expect(s1).toBe(s0);
    expect(patches.length).toBe(0);
  });

  it('SET_PARAM with out-of-range paramIndex is a no-op', () => {
    const s0 = seedProject();
    const [s1] = run(s0, {
      type: 'LOAD_PLUGIN',
      pluginId: 'com.noa.gain',
      target: { kind: 'channel-fx', channelId: 'm2' },
      defaults: [1.0],
      instanceId: 'i_p3',
    });
    const [s2, patches] = run(s1, {
      type: 'SET_PARAM', instanceId: 'i_p3', paramIndex: 99, value: 1,
    });
    expect(s2).toBe(s1);
    expect(patches.length).toBe(0);
  });

  it('SET_INSTANCE_BYPASS toggles bypass on a channel effect', () => {
    const s0 = seedProject();
    const inst = s0.channels.find((c) => c.id === 'm0')!.effects[0]!;
    const [s1] = run(s0, { type: 'SET_INSTANCE_BYPASS', instanceId: inst.id, bypass: true });
    expect(s1.channels.find((c) => c.id === 'm0')!.effects[0]!.bypass).toBe(true);
  });
});

describe('reducer — LOAD_PROJECT', () => {
  it('replaces the entire project with the loaded one', () => {
    const s0 = seedProject();
    const replacement = seedProject();
    replacement.bpm = 88;
    replacement.tracks = replacement.tracks.slice(0, 2);
    replacement.installedPlugins = [];
    const [s1] = run(s0, { type: 'LOAD_PROJECT', project: replacement });
    expect(s1.bpm).toBe(88);
    expect(s1.tracks).toHaveLength(2);
    expect(s1.installedPlugins).toHaveLength(0);
  });

  it('rejects incompatible saves', () => {
    const s0 = seedProject();
    const [s1, patches] = run(s0, {
      type: 'LOAD_PROJECT',
      project: { bpm: 120 /* missing arrays, no schemaVersion */ },
    });
    expect(s1).toBe(s0);
    expect(patches).toEqual([]);
  });

  it('rejects projects with a different schemaVersion', () => {
    const s0 = seedProject();
    const replacement = seedProject();
    replacement.schemaVersion = 999;
    const [s1, patches] = run(s0, { type: 'LOAD_PROJECT', project: replacement });
    expect(s1).toBe(s0);
    expect(patches).toEqual([]);
  });

  it('rejects non-object payloads', () => {
    const s0 = seedProject();
    for (const p of [null, undefined, 'a string', 42]) {
      const [s1, patches] = run(s0, { type: 'LOAD_PROJECT', project: p });
      expect(s1).toBe(s0);
      expect(patches).toEqual([]);
    }
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

  it('SET_LOOP_REGION updates start and end', () => {
    const s0 = seedProject();
    const [s1] = run(s0, { type: 'SET_LOOP_REGION', startBeats: 4, endBeats: 12 });
    expect(s1.loopStartBeats).toBe(4);
    expect(s1.loopEndBeats).toBe(12);
  });

  it('SET_LOOP_REGION clamps start to 0', () => {
    const s0 = seedProject();
    const [s1] = run(s0, { type: 'SET_LOOP_REGION', startBeats: -10, endBeats: 8 });
    expect(s1.loopStartBeats).toBe(0);
    expect(s1.loopEndBeats).toBe(8);
  });

  it('SET_LOOP_REGION pushes end to at least start+1', () => {
    const s0 = seedProject();
    const [s1] = run(s0, { type: 'SET_LOOP_REGION', startBeats: 4, endBeats: 4 });
    expect(s1.loopEndBeats).toBe(5);
    const [s2] = run(s0, { type: 'SET_LOOP_REGION', startBeats: 4, endBeats: 2 });
    expect(s2.loopEndBeats).toBe(5);
  });

  it('SET_LOOP_REGION is a no-op when both bounds are unchanged', () => {
    const s0 = seedProject();
    const [s1, patches] = run(s0, {
      type: 'SET_LOOP_REGION', startBeats: s0.loopStartBeats, endBeats: s0.loopEndBeats,
    });
    expect(s1).toBe(s0);
    expect(patches).toEqual([]);
  });

  it('TOGGLE_METRONOME flips metronome', () => {
    const s0 = seedProject();
    const [s1] = run(s0, { type: 'TOGGLE_METRONOME' });
    expect(s1.metronome).toBe(!s0.metronome);
  });
});

describe('reducer — REORDER_TRACK_EFFECT', () => {
  function withTwoTrackFx() {
    const s0 = seedProject();
    const [s1] = run(s0, {
      type: 'LOAD_PLUGIN', pluginId: 'com.noa.gain',
      target: { kind: 'track-fx', trackId: 't1' }, defaults: [1.0], instanceId: 'i_a',
    });
    const [s2] = run(s1, {
      type: 'LOAD_PLUGIN', pluginId: 'com.noa.gain',
      target: { kind: 'track-fx', trackId: 't1' }, defaults: [1.0], instanceId: 'i_b',
    });
    return s2;
  }

  it('moves a track FX from one slot to another', () => {
    const s0 = withTwoTrackFx();
    const before = s0.tracks.find((t) => t.id === 't1')!.effects.map((e) => e.id);
    const [s1] = run(s0, {
      type: 'REORDER_TRACK_EFFECT', trackId: 't1', fromIndex: 1, toIndex: 0,
    });
    const after = s1.tracks.find((t) => t.id === 't1')!.effects.map((e) => e.id);
    expect(after).toEqual([before[1], before[0]]);
  });

  it('no-op when fromIndex === toIndex', () => {
    const s0 = withTwoTrackFx();
    const [s1, patches] = run(s0, {
      type: 'REORDER_TRACK_EFFECT', trackId: 't1', fromIndex: 0, toIndex: 0,
    });
    expect(s1).toBe(s0);
    expect(patches).toEqual([]);
  });

  it('no-op for out-of-range indices', () => {
    const s0 = withTwoTrackFx();
    const [s1, patches] = run(s0, {
      type: 'REORDER_TRACK_EFFECT', trackId: 't1', fromIndex: 99, toIndex: 0,
    });
    expect(s1).toBe(s0);
    expect(patches).toEqual([]);
  });

  it('no-op for unknown track', () => {
    const s0 = withTwoTrackFx();
    const [s1, patches] = run(s0, {
      type: 'REORDER_TRACK_EFFECT', trackId: 'tZZ', fromIndex: 0, toIndex: 1,
    });
    expect(s1).toBe(s0);
    expect(patches).toEqual([]);
  });
});

describe('reducer — track FX inserts', () => {
  it('LOAD_PLUGIN with target kind track-fx appends to the track effects', () => {
    const s0 = seedProject();
    const t1Before = s0.tracks.find((t) => t.id === 't1')!;
    expect(t1Before.effects).toEqual([]);
    const [s1] = run(s0, {
      type: 'LOAD_PLUGIN',
      pluginId: 'com.noa.gain',
      target: { kind: 'track-fx', trackId: 't1' },
      defaults: [1.0],
    });
    const t1After = s1.tracks.find((t) => t.id === 't1')!;
    expect(t1After.effects).toHaveLength(1);
    expect(t1After.effects[0]!.pluginId).toBe('com.noa.gain');
    // Original generator stays put.
    expect(t1After.generator?.id).toBe(t1Before.generator?.id);
  });

  it('LOAD_PLUGIN track-fx with insertAt inserts at the given position', () => {
    const s0 = seedProject();
    const [s1] = run(s0, {
      type: 'LOAD_PLUGIN', pluginId: 'com.noa.gain',
      target: { kind: 'track-fx', trackId: 't1' }, defaults: [1.0], instanceId: 'i_first',
    });
    const [s2] = run(s1, {
      type: 'LOAD_PLUGIN', pluginId: 'com.noa.gain',
      target: { kind: 'track-fx', trackId: 't1', insertAt: 0 },
      defaults: [1.0], instanceId: 'i_second',
    });
    const effects = s2.tracks.find((t) => t.id === 't1')!.effects;
    expect(effects.map((e) => e.id)).toEqual(['i_second', 'i_first']);
  });

  it('LOAD_PLUGIN track-fx with unknown trackId is a no-op', () => {
    const s0 = seedProject();
    const [s1, patches] = run(s0, {
      type: 'LOAD_PLUGIN', pluginId: 'com.noa.gain',
      target: { kind: 'track-fx', trackId: 'tZZ' }, defaults: [1.0],
    });
    expect(s1).toBe(s0);
    expect(patches.length).toBe(0);
  });

  it('UNLOAD_PLUGIN removes a track FX', () => {
    const s0 = seedProject();
    const [s1] = run(s0, {
      type: 'LOAD_PLUGIN', pluginId: 'com.noa.gain',
      target: { kind: 'track-fx', trackId: 't1' }, defaults: [1.0], instanceId: 'i_tfx',
    });
    const [s2] = run(s1, { type: 'UNLOAD_PLUGIN', instanceId: 'i_tfx' });
    expect(s2.tracks.find((t) => t.id === 't1')!.effects).toHaveLength(0);
    // Generator survives.
    expect(s2.tracks.find((t) => t.id === 't1')!.generator).not.toBeNull();
  });

  it('SET_PARAM works on a track FX instance', () => {
    const s0 = seedProject();
    const [s1] = run(s0, {
      type: 'LOAD_PLUGIN', pluginId: 'com.noa.gain',
      target: { kind: 'track-fx', trackId: 't1' }, defaults: [1.0], instanceId: 'i_tfx',
    });
    const [s2] = run(s1, { type: 'SET_PARAM', instanceId: 'i_tfx', paramIndex: 0, value: 0.25 });
    const fx = s2.tracks.find((t) => t.id === 't1')!.effects[0]!;
    expect(fx.params[0]).toBe(0.25);
  });

  it('SET_INSTANCE_BYPASS works on a track FX instance', () => {
    const s0 = seedProject();
    const [s1] = run(s0, {
      type: 'LOAD_PLUGIN', pluginId: 'com.noa.gain',
      target: { kind: 'track-fx', trackId: 't1' }, defaults: [1.0], instanceId: 'i_tfx',
    });
    const [s2] = run(s1, { type: 'SET_INSTANCE_BYPASS', instanceId: 'i_tfx', bypass: true });
    expect(s2.tracks.find((t) => t.id === 't1')!.effects[0]!.bypass).toBe(true);
  });
});

describe('reducer — SET_SEND_LEVEL', () => {
  it('sets a per-destination send level, creating sendLevels lazily', () => {
    const s0 = seedProject();
    const m2 = s0.channels.find((c) => c.id === 'm2')!;
    expect(m2.sends).toContain('mB');
    expect(m2.sendLevels).toBeUndefined();
    const [s1] = run(s0, {
      type: 'SET_SEND_LEVEL', channelId: 'm2', destChannelId: 'mB', level: 0.7,
    });
    const m2After = s1.channels.find((c) => c.id === 'm2')!;
    expect(m2After.sendLevels).toEqual({ mB: 0.7 });
  });

  it('clamps the level to [0, 1]', () => {
    const s0 = seedProject();
    const [s1] = run(s0, {
      type: 'SET_SEND_LEVEL', channelId: 'm2', destChannelId: 'mB', level: 5,
    });
    expect(s1.channels.find((c) => c.id === 'm2')!.sendLevels!.mB).toBe(1);
    const [s2] = run(s0, {
      type: 'SET_SEND_LEVEL', channelId: 'm2', destChannelId: 'mB', level: -3,
    });
    expect(s2.channels.find((c) => c.id === 'm2')!.sendLevels!.mB).toBe(0);
  });

  it('rejects setting a level for a destination not in the channel sends', () => {
    const s0 = seedProject();
    const [s1, patches] = run(s0, {
      type: 'SET_SEND_LEVEL', channelId: 'm1', destChannelId: 'mB', level: 0.5,
    });
    expect(s1).toBe(s0);
    expect(patches).toEqual([]);
  });

  it('rejects unknown channel', () => {
    const s0 = seedProject();
    const [s1, patches] = run(s0, {
      type: 'SET_SEND_LEVEL', channelId: 'mZZ', destChannelId: 'm0', level: 0.5,
    });
    expect(s1).toBe(s0);
    expect(patches).toEqual([]);
  });
});

describe('reducer — REORDER_EFFECT', () => {
  it('moves an FX from one slot to another', () => {
    const s0 = seedProject();
    // Pad m0 with two more FX so we have something to reorder.
    const [s1] = run(s0, {
      type: 'LOAD_PLUGIN', pluginId: 'com.noa.gain',
      target: { kind: 'channel-fx', channelId: 'm0' }, defaults: [1], instanceId: 'i_a',
    });
    const [s2] = run(s1, {
      type: 'LOAD_PLUGIN', pluginId: 'com.noa.gain',
      target: { kind: 'channel-fx', channelId: 'm0' }, defaults: [1], instanceId: 'i_b',
    });
    const before = s2.channels.find((c) => c.id === 'm0')!.effects.map((e) => e.id);
    // Move the last entry to the front.
    const [s3] = run(s2, {
      type: 'REORDER_EFFECT', channelId: 'm0', fromIndex: before.length - 1, toIndex: 0,
    });
    const after = s3.channels.find((c) => c.id === 'm0')!.effects.map((e) => e.id);
    expect(after[0]).toBe(before[before.length - 1]);
    expect(after).toHaveLength(before.length);
    expect(new Set(after)).toEqual(new Set(before));
  });

  it('no-op when fromIndex === toIndex', () => {
    const s0 = seedProject();
    const [s1, patches] = run(s0, {
      type: 'REORDER_EFFECT', channelId: 'm0', fromIndex: 0, toIndex: 0,
    });
    expect(s1).toBe(s0);
    expect(patches).toEqual([]);
  });

  it('no-op for out-of-range indices', () => {
    const s0 = seedProject();
    const [s1, patches] = run(s0, {
      type: 'REORDER_EFFECT', channelId: 'm0', fromIndex: 99, toIndex: 0,
    });
    expect(s1).toBe(s0);
    expect(patches).toEqual([]);
  });

  it('no-op for unknown channel', () => {
    const s0 = seedProject();
    const [s1, patches] = run(s0, {
      type: 'REORDER_EFFECT', channelId: 'mZZ', fromIndex: 0, toIndex: 0,
    });
    expect(s1).toBe(s0);
    expect(patches).toEqual([]);
  });
});

describe('reducer — installed plugins', () => {
  it('seedProject ships the two built-ins as installedPlugins', () => {
    const s0 = seedProject();
    const ids = s0.installedPlugins.map((p) => p.pluginId).sort();
    expect(ids).toEqual(['com.noa.gain', 'com.noa.sine']);
  });

  it('INSTALL_PLUGIN appends a new entry', () => {
    const s0 = seedProject();
    const before = s0.installedPlugins.length;
    const [s1] = run(s0, {
      type: 'INSTALL_PLUGIN',
      entry: { pluginId: 'com.example.fuzz', version: '0.1.0', name: 'Fuzz', kind: 'fx' },
    });
    expect(s1.installedPlugins).toHaveLength(before + 1);
    expect(s1.installedPlugins.at(-1)).toEqual({
      pluginId: 'com.example.fuzz', version: '0.1.0', name: 'Fuzz', kind: 'fx',
    });
  });

  it('INSTALL_PLUGIN replaces an existing entry with the same pluginId', () => {
    const s0 = seedProject();
    const before = s0.installedPlugins.length;
    const [s1] = run(s0, {
      type: 'INSTALL_PLUGIN',
      entry: { pluginId: 'com.noa.sine', version: '2.0.0', name: 'Sine 2', kind: 'gen' },
    });
    expect(s1.installedPlugins).toHaveLength(before);
    const sine = s1.installedPlugins.find((p) => p.pluginId === 'com.noa.sine')!;
    expect(sine.version).toBe('2.0.0');
    expect(sine.name).toBe('Sine 2');
  });

  it('UNINSTALL_PLUGIN removes an entry', () => {
    const s0 = seedProject();
    const [s1] = run(s0, { type: 'UNINSTALL_PLUGIN', pluginId: 'com.noa.gain' });
    expect(s1.installedPlugins.find((p) => p.pluginId === 'com.noa.gain')).toBeUndefined();
  });

  it('UNINSTALL_PLUGIN with an unknown id is a no-op', () => {
    const s0 = seedProject();
    const [s1, patches] = run(s0, { type: 'UNINSTALL_PLUGIN', pluginId: 'com.example.nope' });
    expect(s1).toBe(s0);
    expect(patches).toEqual([]);
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

describe('reducer — IMPORT_AUDIO', () => {
  const sample = {
    id: 's_user1', name: 'My loop', source: 'import' as const,
    channels: 2, sampleRate: 48000, frames: 96000, durationSec: 2,
  };
  const clip = { id: 'c_user1', trackId: 't8', start: 4, length: 4, label: 'My loop' };

  it('registers the sample and adds an audio clip referencing it', () => {
    const s0 = seedProject();
    const [s1] = run(s0, { type: 'IMPORT_AUDIO', sample, clip });
    const s = s1.samples.find((x) => x.id === 's_user1');
    expect(s).toMatchObject(sample);
    const c = s1.clips.find((x) => x.id === 'c_user1');
    expect(c).toMatchObject({ ...clip, audio: true, sampleId: 's_user1' });
  });

  it('dedupes the sample by id but still adds the clip', () => {
    let s = seedProject();
    [s] = run(s, { type: 'IMPORT_AUDIO', sample, clip });
    const sampleCount = s.samples.length;
    [s] = run(s, { type: 'IMPORT_AUDIO', sample, clip: { ...clip, id: 'c_user2', start: 8 } });
    expect(s.samples.length).toBe(sampleCount); // no duplicate sample
    expect(s.clips.filter((c) => c.sampleId === 's_user1')).toHaveLength(2);
  });

  it('is undoable (produces inverse patches)', () => {
    const s0 = seedProject();
    const [, patches, inverse] = run(s0, { type: 'IMPORT_AUDIO', sample, clip });
    expect(patches.length).toBeGreaterThan(0);
    expect(inverse.length).toBeGreaterThan(0);
  });
});

describe('reducer — sample lifecycle', () => {
  const sample = {
    id: 's_gc', name: 'gc', source: 'import' as const,
    channels: 2, sampleRate: 48000, frames: 100, durationSec: 0.01,
  };

  it('DELETE_CLIP garbage-collects an orphaned sample', () => {
    let s = seedProject();
    [s] = run(s, { type: 'IMPORT_AUDIO', sample, clip: { id: 'c_a', trackId: 't8', start: 0, length: 2, label: 'a' } });
    expect(s.samples.some((x) => x.id === 's_gc')).toBe(true);
    [s] = run(s, { type: 'DELETE_CLIP', clipId: 'c_a' });
    expect(s.clips.some((c) => c.id === 'c_a')).toBe(false);
    expect(s.samples.some((x) => x.id === 's_gc')).toBe(false); // GC'd
  });

  it('DELETE_CLIP keeps a sample still referenced by another clip', () => {
    let s = seedProject();
    [s] = run(s, { type: 'IMPORT_AUDIO', sample, clip: { id: 'c_a', trackId: 't8', start: 0, length: 2, label: 'a' } });
    [s] = run(s, { type: 'IMPORT_AUDIO', sample, clip: { id: 'c_b', trackId: 't8', start: 4, length: 2, label: 'b' } });
    [s] = run(s, { type: 'DELETE_CLIP', clipId: 'c_a' });
    expect(s.samples.some((x) => x.id === 's_gc')).toBe(true); // still used by c_b
  });

  it('LOAD_PROJECT restores the samples table', () => {
    let s = seedProject();
    [s] = run(s, { type: 'IMPORT_AUDIO', sample, clip: { id: 'c_a', trackId: 't8', start: 0, length: 2, label: 'a' } });
    const exported = structuredClone(s);
    const [loaded] = run(seedProject(), { type: 'LOAD_PROJECT', project: exported });
    expect(loaded.samples.some((x) => x.id === 's_gc')).toBe(true);
  });
});
