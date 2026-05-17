// @ts-expect-error data.js is loose JS, this is the one place we type-launder it.
import { DEMO_TRACKS, DEMO_CLIPS, DEMO_CHANNELS } from '../data.js';

export interface Track {
  id: string;
  name: string;
  type: 'midi' | 'audio';
  color: number;
  generator: string | null;
  channel: number;
  mute: boolean;
  solo: boolean;
  vol: number;
}

export interface Pattern {
  notes: [number, number, number][];
}

export interface Clip {
  id: string;
  trackId: string;
  start: number;
  length: number;
  label: string;
  pattern?: Pattern;
  audio?: boolean;
}

export type EffectKind = 'eq' | 'comp' | 'limit' | 'fx' | 'enhance' | 'master';

export interface Effect {
  id: string;
  name: string;
  kind: EffectKind;
  bypass: boolean;
}

export interface Channel {
  id: string;
  name: string;
  color: number | null;
  vol: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  sends: string[];
  effects: Effect[];
}

export interface Project {
  tracks: Track[];
  clips: Clip[];
  channels: Channel[];
  bpm: number;
  loop: boolean;
  metronome: boolean;
}

export function seedProject(): Project {
  return {
    tracks: structuredClone(DEMO_TRACKS) as Track[],
    clips: structuredClone(DEMO_CLIPS) as Clip[],
    channels: structuredClone(DEMO_CHANNELS) as Channel[],
    bpm: 124,
    loop: true,
    metronome: false,
  };
}
