export type Action =
  | { type: 'MOVE_CLIP'; clipId: string; start: number }
  | { type: 'UPDATE_CLIP_NOTES'; clipId: string; notes: [number, number, number][] }
  | { type: 'UPDATE_CLIP_LENGTH'; clipId: string; length: number }
  | { type: 'SET_CLIP_LENGTH'; clipId: string; length: number }
  | { type: 'DELETE_CLIP'; clipId: string }
  | { type: 'DUPLICATE_CLIP'; clipId: string; newId?: string }
  | { type: 'SET_CLIP_LABEL'; clipId: string; label: string }
  | { type: 'TOGGLE_TRACK_MUTE'; trackId: string }
  | { type: 'TOGGLE_TRACK_SOLO'; trackId: string }
  | { type: 'SET_TRACK_NAME'; trackId: string; name: string }
  | {
      // Register a decoded audio sample and create an audio clip that plays it,
      // in one undoable step (used by drag-an-audio-file import). The PCM lives
      // in OPFS + the worklet, not the project — see projectModel.ts `Sample`.
      type: 'IMPORT_AUDIO';
      sample: {
        id: string;
        name: string;
        source: 'import';
        channels: number;
        sampleRate: number;
        frames: number;
        durationSec: number;
      };
      clip: { id: string; trackId: string; start: number; length: number; label: string };
    }
  | {
      type: 'LOAD_PLUGIN';
      pluginId: string;
      target:
        | { kind: 'channel-fx'; channelId: string; insertAt?: number }
        | { kind: 'track-fx'; trackId: string; insertAt?: number }
        | { kind: 'track-generator'; trackId: string };
      defaults: number[];
      /** Optional explicit instance id (defaults to a fresh random id). */
      instanceId?: string;
    }
  | { type: 'UNLOAD_PLUGIN'; instanceId: string }
  | { type: 'REORDER_EFFECT'; channelId: string; fromIndex: number; toIndex: number }
  | { type: 'REORDER_TRACK_EFFECT'; trackId: string; fromIndex: number; toIndex: number }
  | { type: 'SET_PARAM'; instanceId: string; paramIndex: number; value: number }
  | { type: 'SET_INSTANCE_BYPASS'; instanceId: string; bypass: boolean }
  | { type: 'SET_FADER'; channelId: string; value: number }
  | { type: 'SET_PAN'; channelId: string; value: number }
  | { type: 'SET_SEND_LEVEL'; channelId: string; destChannelId: string; level: number }
  | { type: 'TOGGLE_CHANNEL_MUTE'; channelId: string }
  | { type: 'TOGGLE_CHANNEL_SOLO'; channelId: string }
  | { type: 'SET_BPM'; bpm: number }
  | { type: 'TOGGLE_LOOP' }
  | { type: 'SET_LOOP_REGION'; startBeats: number; endBeats: number }
  | { type: 'TOGGLE_METRONOME' }
  | { type: 'LOAD_PROJECT'; project: unknown }
  | {
      type: 'INSTALL_PLUGIN';
      entry: {
        pluginId: string;
        version: string;
        name: string;
        kind: 'gen' | 'fx';
      };
    }
  | { type: 'UNINSTALL_PLUGIN'; pluginId: string };

export type ActionType = Action['type'];
