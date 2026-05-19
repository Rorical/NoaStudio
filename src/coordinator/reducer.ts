import { enablePatches, produceWithPatches, type Patch } from 'immer';
import type { Project, PluginInstance } from './projectModel';
import type { Action } from './actions';

enablePatches();

export type ReducerResult = readonly [Project, Patch[], Patch[]];

function findInstance(
  draft: Project,
  instanceId: string,
): PluginInstance | undefined {
  for (const t of draft.tracks) {
    if (t.generator && t.generator.id === instanceId) return t.generator;
    const fx = t.effects.find((e) => e.id === instanceId);
    if (fx) return fx;
  }
  for (const ch of draft.channels) {
    const found = ch.effects.find((e) => e.id === instanceId);
    if (found) return found;
  }
  return undefined;
}

function mintInstanceId(): string {
  return 'i' + Math.random().toString(36).slice(2, 10);
}

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
      case 'LOAD_PLUGIN': {
        const inst: PluginInstance = {
          id: action.instanceId ?? mintInstanceId(),
          pluginId: action.pluginId,
          bypass: false,
          params: [...action.defaults],
        };
        const target = action.target;
        if (target.kind === 'track-generator') {
          const t = draft.tracks.find((x) => x.id === target.trackId);
          if (t) {
            t.generator = inst;
            t.type = 'midi';
          }
        } else if (target.kind === 'track-fx') {
          const t = draft.tracks.find((x) => x.id === target.trackId);
          if (t) {
            const at = target.insertAt ?? t.effects.length;
            t.effects.splice(at, 0, inst);
          }
        } else {
          const ch = draft.channels.find((c) => c.id === target.channelId);
          if (ch) {
            const at = target.insertAt ?? ch.effects.length;
            ch.effects.splice(at, 0, inst);
          }
        }
        return;
      }
      case 'UNLOAD_PLUGIN': {
        for (const t of draft.tracks) {
          if (t.generator && t.generator.id === action.instanceId) {
            t.generator = null;
            return;
          }
          const trackFxIdx = t.effects.findIndex((e) => e.id === action.instanceId);
          if (trackFxIdx >= 0) {
            t.effects.splice(trackFxIdx, 1);
            return;
          }
        }
        for (const ch of draft.channels) {
          const idx = ch.effects.findIndex((e) => e.id === action.instanceId);
          if (idx >= 0) {
            ch.effects.splice(idx, 1);
            return;
          }
        }
        return;
      }
      case 'REORDER_EFFECT': {
        const ch = draft.channels.find((c) => c.id === action.channelId);
        if (!ch) return;
        const { fromIndex, toIndex } = action;
        if (fromIndex < 0 || fromIndex >= ch.effects.length) return;
        if (toIndex < 0 || toIndex >= ch.effects.length) return;
        if (fromIndex === toIndex) return;
        const [moved] = ch.effects.splice(fromIndex, 1);
        if (!moved) return;
        ch.effects.splice(toIndex, 0, moved);
        return;
      }
      case 'REORDER_TRACK_EFFECT': {
        const t = draft.tracks.find((x) => x.id === action.trackId);
        if (!t) return;
        const { fromIndex, toIndex } = action;
        if (fromIndex < 0 || fromIndex >= t.effects.length) return;
        if (toIndex < 0 || toIndex >= t.effects.length) return;
        if (fromIndex === toIndex) return;
        const [moved] = t.effects.splice(fromIndex, 1);
        if (!moved) return;
        t.effects.splice(toIndex, 0, moved);
        return;
      }
      case 'SET_PARAM': {
        const inst = findInstance(draft, action.instanceId);
        if (!inst) return;
        if (action.paramIndex < 0 || action.paramIndex >= inst.params.length) return;
        inst.params[action.paramIndex] = action.value;
        return;
      }
      case 'SET_INSTANCE_BYPASS': {
        const inst = findInstance(draft, action.instanceId);
        if (inst) inst.bypass = action.bypass;
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
      case 'SET_SEND_LEVEL': {
        const ch = draft.channels.find((c) => c.id === action.channelId);
        if (!ch) return;
        if (!ch.sends.includes(action.destChannelId)) return;
        const level = Math.max(0, Math.min(1, action.level));
        if (!ch.sendLevels) ch.sendLevels = {};
        ch.sendLevels[action.destChannelId] = level;
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
      case 'INSTALL_PLUGIN': {
        const entry = action.entry;
        const idx = draft.installedPlugins.findIndex((p) => p.pluginId === entry.pluginId);
        if (idx >= 0) {
          draft.installedPlugins[idx] = { ...entry };
        } else {
          draft.installedPlugins.push({ ...entry });
        }
        return;
      }
      case 'UNINSTALL_PLUGIN': {
        const idx = draft.installedPlugins.findIndex((p) => p.pluginId === action.pluginId);
        if (idx >= 0) draft.installedPlugins.splice(idx, 1);
        return;
      }
      default: {
        const _exhaustive: never = action;
        void _exhaustive;
        return;
      }
    }
  });
}
