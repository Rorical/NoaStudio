import { enablePatches, produceWithPatches, type Patch } from 'immer';
import type { Project } from './projectModel';
import type { Action } from './actions';

enablePatches();

export type ReducerResult = readonly [Project, Patch[], Patch[]];

export function applyAction(state: Project, action: Action): ReducerResult {
  return produceWithPatches(state, (draft) => {
    switch (action.type) {
      case 'MOVE_CLIP': {
        const c = draft.clips.find((x) => x.id === action.clipId);
        if (c) c.start = action.start;
        return;
      }
      case 'UPDATE_CLIP_NOTES': {
        const c = draft.clips.find((x) => x.id === action.clipId);
        if (c) {
          if (!c.pattern) c.pattern = { notes: [] };
          c.pattern.notes = action.notes;
        }
        return;
      }
      case 'UPDATE_CLIP_LENGTH': {
        const c = draft.clips.find((x) => x.id === action.clipId);
        if (c && action.length > c.length) c.length = action.length;
        return;
      }
      case 'TOGGLE_TRACK_MUTE': {
        const t = draft.tracks.find((x) => x.id === action.trackId);
        if (!t) return;
        t.mute = !t.mute;
        const ch = draft.channels.find((c) => c.id === 'm' + t.channel);
        if (ch) ch.mute = !ch.mute;
        return;
      }
      case 'TOGGLE_TRACK_SOLO': {
        const t = draft.tracks.find((x) => x.id === action.trackId);
        if (!t) return;
        t.solo = !t.solo;
        const ch = draft.channels.find((c) => c.id === 'm' + t.channel);
        if (ch) ch.solo = !ch.solo;
        return;
      }
      case 'ASSIGN_GENERATOR': {
        const t = draft.tracks.find((x) => x.id === action.trackId);
        if (t) {
          t.generator = action.generator;
          t.type = 'midi';
        }
        return;
      }
      case 'ADD_EFFECT': {
        const ch = draft.channels.find((c) => c.id === action.channelId);
        if (ch) ch.effects.push(action.effect);
        return;
      }
      case 'REMOVE_EFFECT': {
        const ch = draft.channels.find((c) => c.id === action.channelId);
        if (ch) ch.effects = ch.effects.filter((e) => e.id !== action.effectId);
        return;
      }
      case 'BYPASS_EFFECT': {
        const ch = draft.channels.find((c) => c.id === action.channelId);
        if (!ch) return;
        const e = ch.effects.find((x) => x.id === action.effectId);
        if (e) e.bypass = !e.bypass;
        return;
      }
      case 'SET_FADER': {
        const ch = draft.channels.find((c) => c.id === action.channelId);
        if (ch) ch.vol = action.value;
        return;
      }
      case 'SET_PAN': {
        const ch = draft.channels.find((c) => c.id === action.channelId);
        if (ch) ch.pan = action.value;
        return;
      }
      case 'TOGGLE_CHANNEL_MUTE': {
        const ch = draft.channels.find((c) => c.id === action.channelId);
        if (ch) ch.mute = !ch.mute;
        return;
      }
      case 'TOGGLE_CHANNEL_SOLO': {
        const ch = draft.channels.find((c) => c.id === action.channelId);
        if (ch) ch.solo = !ch.solo;
        return;
      }
      case 'SET_BPM': {
        draft.bpm = action.bpm;
        return;
      }
      case 'TOGGLE_LOOP': {
        draft.loop = !draft.loop;
        return;
      }
      case 'TOGGLE_METRONOME': {
        draft.metronome = !draft.metronome;
        return;
      }
    }
  });
}
