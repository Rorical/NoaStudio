// @ts-expect-error data.js is loose JS, this is the one place we type-launder it.
import { DEMO_TRACKS, DEMO_CLIPS, DEMO_CHANNELS } from '../data.js';

/**
 * One plugin instance — a loaded WASM plugin on a channel's FX rack or a track's
 * generator slot. The pluginId points into the engine's PluginRegistry.
 */
export interface PluginInstance {
  id: string;
  pluginId: string;
  bypass: boolean;
  /** Canonical parameter values, indexed per the plugin manifest's param order. */
  params: number[];
}

export interface Track {
  id: string;
  name: string;
  type: 'midi' | 'audio';
  color: number;
  /** The track's generator plugin instance. `null` when the track has no generator. */
  generator: PluginInstance | null;
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

export interface Channel {
  id: string;
  name: string;
  color: number | null;
  vol: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  sends: string[];
  effects: PluginInstance[];
}

/**
 * A plugin available to the user — already unpacked into OPFS at
 * /plugins/<pluginId>/<version>/. The runtime resolves these to wasm bytes
 * via the Service Worker or, in the fallback path, by reading OPFS directly.
 */
export interface InstalledPlugin {
  pluginId: string;
  version: string;
  name: string;
  kind: 'gen' | 'fx';
}

export interface Project {
  tracks: Track[];
  clips: Clip[];
  channels: Channel[];
  bpm: number;
  loop: boolean;
  metronome: boolean;
  installedPlugins: InstalledPlugin[];
}

const SEED_INSTALLED_PLUGINS: InstalledPlugin[] = [
  { pluginId: 'com.noa.sine', version: '1.0.0', name: 'Sine', kind: 'gen' },
  { pluginId: 'com.noa.gain', version: '1.0.0', name: 'Gain', kind: 'fx' },
];

export function seedProject(): Project {
  return {
    tracks: structuredClone(DEMO_TRACKS) as Track[],
    clips: structuredClone(DEMO_CLIPS) as Clip[],
    channels: structuredClone(DEMO_CHANNELS) as Channel[],
    bpm: 124,
    loop: true,
    metronome: false,
    installedPlugins: structuredClone(SEED_INSTALLED_PLUGINS),
  };
}
