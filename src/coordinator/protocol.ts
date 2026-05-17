import type { Patch } from 'immer';
import type { Project } from './projectModel';
import type { Action } from './actions';

export type ClientToWorker =
  | { kind: 'hello' }
  | { kind: 'dispatch'; action: Action }
  | { kind: 'undo' }
  | { kind: 'redo' };

export type WorkerToClient =
  | { kind: 'snapshot'; state: Project }
  | { kind: 'patch'; patches: Patch[]; sourcePortId: number }
  | { kind: 'history-changed'; canUndo: boolean; canRedo: boolean };
