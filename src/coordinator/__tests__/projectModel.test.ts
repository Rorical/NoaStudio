import { describe, it, expect } from 'vitest';
import {
  seedProject, isProjectCompatible, CURRENT_SCHEMA_VERSION, type Project,
} from '../projectModel';

describe('seedProject', () => {
  it('returns a Project with non-empty arrays', () => {
    const p: Project = seedProject();
    expect(p.tracks.length).toBeGreaterThan(0);
    expect(p.clips.length).toBeGreaterThan(0);
    expect(p.channels.length).toBeGreaterThan(0);
  });

  it('has sensible defaults for project-level settings', () => {
    const p = seedProject();
    expect(typeof p.bpm).toBe('number');
    expect(p.bpm).toBeGreaterThan(30);
    expect(p.bpm).toBeLessThan(300);
    expect(typeof p.loop).toBe('boolean');
    expect(typeof p.metronome).toBe('boolean');
  });

  it('each clip references an existing track', () => {
    const p = seedProject();
    const trackIds = new Set(p.tracks.map((t) => t.id));
    for (const c of p.clips) {
      expect(trackIds.has(c.trackId)).toBe(true);
    }
  });

  it('each track references a channel number that resolves to a channel id', () => {
    const p = seedProject();
    const channelIds = new Set(p.channels.map((c) => c.id));
    for (const t of p.tracks) {
      expect(channelIds.has('m' + t.channel)).toBe(true);
    }
  });

  it('master channel m0 exists', () => {
    const p = seedProject();
    expect(p.channels.find((c) => c.id === 'm0')?.name).toBe('Master');
  });

  it('two calls return structurally-equal but distinct objects', () => {
    const a = seedProject();
    const b = seedProject();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.tracks).not.toBe(b.tracks);
  });

  it('stamps the current schema version', () => {
    expect(seedProject().schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe('isProjectCompatible', () => {
  it('accepts a freshly-seeded project', () => {
    expect(isProjectCompatible(seedProject())).toBe(true);
  });

  it('rejects null, undefined, primitives', () => {
    expect(isProjectCompatible(null)).toBe(false);
    expect(isProjectCompatible(undefined)).toBe(false);
    expect(isProjectCompatible(42)).toBe(false);
    expect(isProjectCompatible('hi')).toBe(false);
  });

  it('rejects projects with the wrong schema version', () => {
    const p = seedProject();
    p.schemaVersion = CURRENT_SCHEMA_VERSION - 1;
    expect(isProjectCompatible(p)).toBe(false);
    p.schemaVersion = CURRENT_SCHEMA_VERSION + 99;
    expect(isProjectCompatible(p)).toBe(false);
  });

  it('rejects projects that have no schemaVersion at all (pre-versioning state)', () => {
    const p: Partial<Project> = { ...seedProject() };
    delete (p as { schemaVersion?: number }).schemaVersion;
    expect(isProjectCompatible(p)).toBe(false);
  });

  it('rejects projects missing load-bearing arrays', () => {
    const p = seedProject();
    // @ts-expect-error simulating a broken save
    delete p.installedPlugins;
    expect(isProjectCompatible(p)).toBe(false);
  });

  it('rejects projects with a non-number bpm', () => {
    const p = seedProject();
    // @ts-expect-error simulating a broken save
    p.bpm = 'fast';
    expect(isProjectCompatible(p)).toBe(false);
  });
});
