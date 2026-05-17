import type { Patch } from 'immer';

export interface Transaction {
  patches: Patch[];
  inversePatches: Patch[];
}

export interface HistoryResult {
  patchesToApply: Patch[];
}

const MAX_HISTORY = 100;

export class HistoryStack {
  private undoStack: Transaction[] = [];
  private redoStack: Transaction[] = [];

  push(tx: Transaction): void {
    this.undoStack.push(tx);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(): HistoryResult | null {
    const tx = this.undoStack.pop();
    if (!tx) return null;
    this.redoStack.push(tx);
    return { patchesToApply: tx.inversePatches };
  }

  redo(): HistoryResult | null {
    const tx = this.redoStack.pop();
    if (!tx) return null;
    this.undoStack.push(tx);
    return { patchesToApply: tx.patches };
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}
