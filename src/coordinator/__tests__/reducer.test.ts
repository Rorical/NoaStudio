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
