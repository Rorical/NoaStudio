import type { Effect } from './projectModel';

export type Action =
  | { type: 'MOVE_CLIP'; clipId: string; start: number }
  | { type: 'UPDATE_CLIP_NOTES'; clipId: string; notes: [number, number, number][] }
  | { type: 'UPDATE_CLIP_LENGTH'; clipId: string; length: number }
  | { type: 'TOGGLE_TRACK_MUTE'; trackId: string }
  | { type: 'TOGGLE_TRACK_SOLO'; trackId: string }
  | { type: 'ASSIGN_GENERATOR'; trackId: string; generator: string }
  | { type: 'ADD_EFFECT'; channelId: string; effect: Effect }
  | { type: 'REMOVE_EFFECT'; channelId: string; effectId: string }
  | { type: 'BYPASS_EFFECT'; channelId: string; effectId: string }
  | { type: 'SET_FADER'; channelId: string; value: number }
  | { type: 'SET_PAN'; channelId: string; value: number }
  | { type: 'TOGGLE_CHANNEL_MUTE'; channelId: string }
  | { type: 'TOGGLE_CHANNEL_SOLO'; channelId: string }
  | { type: 'SET_BPM'; bpm: number }
  | { type: 'TOGGLE_LOOP' }
  | { type: 'TOGGLE_METRONOME' };

export type ActionType = Action['type'];
