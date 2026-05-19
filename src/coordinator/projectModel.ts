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
  /** Pre-channel FX inserts. Each is chained after the generator (slot 0)
   *  in the track's worklet PluginChain at slot 1..N. */
  effects: PluginInstance[];
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
  /**
   * Per-destination send level. Keys are destination channel ids that also
   * appear in `sends`; values are 0..1 (1 = full level). Missing entries
   * default to 1 — that's the legacy behaviour from before this field
   * existed.
   */
  sendLevels?: Record<string, number>;
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

/**
 * Project schema version. Bump on every breaking field change. Persisted
 * Projects whose `schemaVersion` doesn't match the current value are
 * discarded by the coordinator on load (a future migration pass can run
 * here instead).
 */
export const CURRENT_SCHEMA_VERSION = 2;

export interface Project {
  schemaVersion: number;
  tracks: Track[];
  clips: Clip[];
  channels: Channel[];
  bpm: number;
  loop: boolean;
  metronome: boolean;
  installedPlugins: InstalledPlugin[];
}

/**
 * Structural compatibility check for a freshly-loaded persisted Project. A
 * Project is compatible when its `schemaVersion` matches the current
 * version and the load-bearing top-level arrays exist. Returning `false`
 * means the coordinator drops the saved state and re-seeds.
 */
export function isProjectCompatible(p: unknown): p is Project {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return o.schemaVersion === CURRENT_SCHEMA_VERSION
    && Array.isArray(o.tracks)
    && Array.isArray(o.clips)
    && Array.isArray(o.channels)
    && Array.isArray(o.installedPlugins)
    && typeof o.bpm === 'number';
}

const SEED_INSTALLED_PLUGINS: InstalledPlugin[] = [
  { pluginId: 'com.noa.sine', version: '1.0.0', name: 'Sine', kind: 'gen' },
  { pluginId: 'com.noa.gain', version: '1.0.0', name: 'Gain', kind: 'fx' },
];

export function seedProject(): Project {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    tracks: structuredClone(DEMO_TRACKS) as Track[],
    clips: structuredClone(DEMO_CLIPS) as Clip[],
    channels: structuredClone(DEMO_CHANNELS) as Channel[],
    bpm: 124,
    loop: true,
    metronome: false,
    installedPlugins: structuredClone(SEED_INSTALLED_PLUGINS),
  };
}
