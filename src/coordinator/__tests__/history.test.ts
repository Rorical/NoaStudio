import { describe, it, expect } from 'vitest';
import { HistoryStack } from '../history';
import { applyAction } from '../reducer';
import { seedProject } from '../projectModel';
import { applyPatches } from 'immer';

describe('HistoryStack', () => {
  it('starts empty', () => {
    const h = new HistoryStack();
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
  });

  it('push enables undo and clears redo', () => {
    const h = new HistoryStack();
    h.push({ patches: [], inversePatches: [] });
    expect(h.canUndo()).toBe(true);
    expect(h.canRedo()).toBe(false);
  });

  it('undo returns inverse patches and enables redo', () => {
    const s0 = seedProject();
    const [s1, patches, inverse] = applyAction(s0, { type: 'SET_BPM', bpm: 200 });
    const h = new HistoryStack();
    h.push({ patches, inversePatches: inverse });
    const result = h.undo();
    expect(result).not.toBeNull();
    expect(result!.patchesToApply).toBe(inverse);
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(true);
    // Sanity: applying those inverse patches actually reverts the state.
    const reverted = applyPatches(s1, result!.patchesToApply);
    expect(reverted.bpm).toBe(s0.bpm);
  });

  it('redo returns forward patches and re-enables undo', () => {
    const s0 = seedProject();
    const [s1, patches, inverse] = applyAction(s0, { type: 'SET_BPM', bpm: 200 });
    const h = new HistoryStack();
    h.push({ patches, inversePatches: inverse });
    h.undo();
    const result = h.redo();
    expect(result).not.toBeNull();
    expect(result!.patchesToApply).toBe(patches);
    expect(h.canUndo()).toBe(true);
    expect(h.canRedo()).toBe(false);
    const re = applyPatches(s0, result!.patchesToApply);
    expect(re.bpm).toBe(s1.bpm);
  });

  it('a new push after an undo clears the redo stack', () => {
    const h = new HistoryStack();
    h.push({ patches: [{ op: 'replace', path: ['bpm'], value: 100 }], inversePatches: [{ op: 'replace', path: ['bpm'], value: 124 }] });
    h.undo();
    expect(h.canRedo()).toBe(true);
    h.push({ patches: [{ op: 'replace', path: ['bpm'], value: 200 }], inversePatches: [{ op: 'replace', path: ['bpm'], value: 124 }] });
    expect(h.canRedo()).toBe(false);
  });

  it('undo on empty stack returns null', () => {
    const h = new HistoryStack();
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBeNull();
  });

  it('caps at 100 entries (oldest dropped)', () => {
    const h = new HistoryStack();
    for (let i = 0; i < 150; i++) {
      h.push({
        patches: [{ op: 'replace', path: ['bpm'], value: i + 1 }],
        inversePatches: [{ op: 'replace', path: ['bpm'], value: i }],
      });
    }
    // After 150 pushes, undoing 100 times should succeed; the 101st should return null.
    for (let i = 0; i < 100; i++) {
      expect(h.undo()).not.toBeNull();
    }
    expect(h.undo()).toBeNull();
  });

  it('caps drop the oldest entry: the surviving 100 are the most recent', () => {
    const h = new HistoryStack();
    for (let i = 0; i < 150; i++) {
      h.push({
        patches: [{ op: 'replace', path: ['bpm'], value: i + 1 }],
        inversePatches: [{ op: 'replace', path: ['bpm'], value: i }],
      });
    }
    // Undo once → last push (i=149) should be popped. Its forward patch sets bpm=150.
    const r = h.undo();
    expect(r!.patchesToApply[0]).toMatchObject({ value: 149 });
    // After exhausting all 100 undos, the oldest still-present should be i=50.
    let last: typeof r = null;
    while (h.canUndo()) last = h.undo();
    expect(last!.patchesToApply[0]).toMatchObject({ value: 50 });
  });

  it('multiple sequential undo/redo cycles preserve the forward/inverse pair', () => {
    const s0 = seedProject();
    const [s1, p1, i1] = applyAction(s0, { type: 'SET_BPM', bpm: 200 });
    const h = new HistoryStack();
    h.push({ patches: p1, inversePatches: i1 });
    for (let i = 0; i < 5; i++) {
      const u = h.undo();
      expect(u!.patchesToApply).toBe(i1);
      const r = h.redo();
      expect(r!.patchesToApply).toBe(p1);
    }
    // After the loop, applying the forward patch to s0 should yield s1.bpm.
    expect(applyPatches(s0, p1).bpm).toBe(s1.bpm);
  });

  it('stacked undos walk back through every transaction in reverse order', () => {
    const h = new HistoryStack();
    h.push({ patches: [{ op: 'replace', path: ['bpm'], value: 100 }], inversePatches: [{ op: 'replace', path: ['bpm'], value: 124 }] });
    h.push({ patches: [{ op: 'replace', path: ['bpm'], value: 110 }], inversePatches: [{ op: 'replace', path: ['bpm'], value: 100 }] });
    h.push({ patches: [{ op: 'replace', path: ['bpm'], value: 120 }], inversePatches: [{ op: 'replace', path: ['bpm'], value: 110 }] });
    // Each undo should return inverse of the most-recently-pushed transaction.
    expect(h.undo()!.patchesToApply[0]).toMatchObject({ value: 110 });
    expect(h.undo()!.patchesToApply[0]).toMatchObject({ value: 100 });
    expect(h.undo()!.patchesToApply[0]).toMatchObject({ value: 124 });
    expect(h.undo()).toBeNull();
  });

  it('push with empty patches still consumes a stack slot', () => {
    // The history file docs say callers should guard, but the stack itself
    // doesn't, so empty-patch transactions DO occupy space.
    const h = new HistoryStack();
    h.push({ patches: [], inversePatches: [] });
    expect(h.canUndo()).toBe(true);
    const r = h.undo();
    expect(r!.patchesToApply).toEqual([]);
  });
});
