import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PluginInstance } from '../PluginInstance';
import { parseManifest, type PluginManifest } from '../PluginManifest';
import {
  EVENT_FRAME_SIZE,
  encodeEvent,
  EVT_NOTE_ON, EVT_NOTE_OFF,
} from '../EngineEvent';

const PLUGIN_DIR = path.resolve('src/builtin-plugins/sine');
const SR = 48000;
const BLOCK = 128;

let bytes: ArrayBuffer;
let manifest: PluginManifest;

beforeAll(async () => {
  const buf = await readFile(path.join(PLUGIN_DIR, 'sine.wasm'));
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  bytes = ab;
  manifest = parseManifest(
    JSON.parse((await readFile(path.join(PLUGIN_DIR, 'plugin.json'))).toString('utf8')),
  );
});

const MAX_PLUGIN_BLOCK = 2048; // matches the plugin's compile-time cap

function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / buf.length);
}

function pushNoteOn(inst: PluginInstance, note: number, velocity: number, frameOffset = 0): void {
  const frame = new Uint8Array(EVENT_FRAME_SIZE);
  encodeEvent({
    type: EVT_NOTE_ON, frameOffset, targetId: 0, note, velocity, channel: 0,
  }, frame);
  inst.pushEvents(frame, 1);
}

function pushNoteOff(inst: PluginInstance, note: number, frameOffset = 0): void {
  const frame = new Uint8Array(EVENT_FRAME_SIZE);
  encodeEvent({
    type: EVT_NOTE_OFF, frameOffset, targetId: 0, note, channel: 0,
  }, frame);
  inst.pushEvents(frame, 1);
}

/**
 * Drive the plugin through `totalSamples` of process() calls, returning the
 * concatenated interleaved-stereo output. `seedEvents` is the event count for
 * the first block; subsequent blocks pass 0 (the plugin's event buffer is not
 * re-pushed between blocks).
 */
function processLong(
  inst: PluginInstance,
  totalSamples: number,
  seedEvents: number,
  blockSize: number = MAX_PLUGIN_BLOCK,
): Float32Array {
  const out = new Float32Array(totalSamples * 2);
  let pos = 0;
  let firstBlock = true;
  while (pos < totalSamples) {
    const n = Math.min(blockSize, totalSamples - pos);
    inst.process(n, firstBlock ? seedEvents : 0);
    const chunk = new Float32Array(n * 2);
    inst.readOutput(chunk);
    out.set(chunk, pos * 2);
    pos += n;
    firstBlock = false;
  }
  return out;
}

describe('com.noa.sine', () => {
  it('has the expected manifest', () => {
    expect(manifest.id).toBe('com.noa.sine');
    expect(manifest.kind).toBe('gen');
    expect(manifest.params.map((p) => p.name)).toEqual(['Volume', 'Octave']);
  });

  it('produces silence with no notes', async () => {
    const inst = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: SR, maxBlockSize: BLOCK });
    inst.process(BLOCK, 0);
    const out = new Float32Array(BLOCK * 2);
    inst.readOutput(out);
    expect(rms(out)).toBe(0);
    inst.destroy();
  });

  it('produces non-zero audio after NoteOn', async () => {
    const inst = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: SR, maxBlockSize: MAX_PLUGIN_BLOCK });
    pushNoteOn(inst, 69, 127);
    const out = processLong(inst, 2048, 1);
    expect(rms(out)).toBeGreaterThan(0.05);
    inst.destroy();
  });

  it('A4 (note 69) generates ~440 Hz', async () => {
    const inst = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: SR, maxBlockSize: MAX_PLUGIN_BLOCK });
    pushNoteOn(inst, 69, 127);
    const out = processLong(inst, SR, 1); // 1 second
    let crossings = 0;
    for (let i = 1; i < SR; i++) {
      const a = out[(i - 1) * 2]!;
      const b = out[i * 2]!;
      if (a <= 0 && b > 0) crossings++;
    }
    expect(crossings).toBeGreaterThan(420);
    expect(crossings).toBeLessThan(460);
    inst.destroy();
  });

  it('writes identical L and R samples (mono-cloned stereo)', async () => {
    const inst = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: SR, maxBlockSize: BLOCK });
    pushNoteOn(inst, 60, 100);
    inst.process(BLOCK, 1);
    const out = new Float32Array(BLOCK * 2);
    inst.readOutput(out);
    for (let i = 0; i < BLOCK; i++) {
      expect(out[i * 2]).toBe(out[i * 2 + 1]);
    }
    inst.destroy();
  });

  it('respects the Volume parameter', async () => {
    const a = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: SR, maxBlockSize: MAX_PLUGIN_BLOCK });
    a.setParam(0, 1.0);
    pushNoteOn(a, 69, 127);
    const outA = processLong(a, 2048, 1);

    const b = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: SR, maxBlockSize: MAX_PLUGIN_BLOCK });
    b.setParam(0, 0.25);
    pushNoteOn(b, 69, 127);
    const outB = processLong(b, 2048, 1);

    // 0.25× volume → roughly a quarter of the RMS.
    expect(rms(outB)).toBeLessThan(rms(outA) * 0.4);
    expect(rms(outB)).toBeGreaterThan(rms(outA) * 0.1);
    a.destroy();
    b.destroy();
  });

  it('Octave +1 doubles the frequency of any note', async () => {
    const inst = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: SR, maxBlockSize: MAX_PLUGIN_BLOCK });
    inst.setParam(1, 1);
    pushNoteOn(inst, 69, 127); // A4 → A5 (~880 Hz)
    const out = processLong(inst, SR, 1);
    let crossings = 0;
    for (let i = 1; i < SR; i++) {
      const a = out[(i - 1) * 2]!;
      const b = out[i * 2]!;
      if (a <= 0 && b > 0) crossings++;
    }
    expect(crossings).toBeGreaterThan(840);
    expect(crossings).toBeLessThan(920);
    inst.destroy();
  });

  it('NoteOff triggers a release that drops to silence', async () => {
    const inst = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: SR, maxBlockSize: MAX_PLUGIN_BLOCK });
    pushNoteOn(inst, 60, 127);
    const before = processLong(inst, 1024, 1);
    const headRms = rms(before);

    pushNoteOff(inst, 60);
    const tailOut = processLong(inst, 4096, 1);
    const tail = tailOut.subarray(tailOut.length - 512);
    expect(rms(tail)).toBeLessThan(headRms * 0.05);
    inst.destroy();
  });

  it('round-trips state via getState / setState (8 bytes)', async () => {
    const a = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: SR, maxBlockSize: BLOCK });
    a.setParam(0, 0.33);
    a.setParam(1, -1);
    const snapshot = a.getState();
    expect(snapshot.byteLength).toBe(8);
    a.destroy();

    const b = await PluginInstance.fromBytes(bytes, manifest, { sampleRate: SR, maxBlockSize: BLOCK });
    expect(b.setState(snapshot)).toBe(true);
    expect(b.readParam(0)).toBeCloseTo(0.33, 5);
    expect(b.readParam(1)).toBeCloseTo(-1, 5);
    b.destroy();
  });
});
