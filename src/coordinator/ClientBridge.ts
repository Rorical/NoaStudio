import { applyPatches } from 'immer';
import type { Project } from './projectModel';
import type { Action } from './actions';
import type { ClientToWorker, WorkerToClient } from './protocol';

export class ClientBridge {
  private state: Project | null = null;
  private undoFlag = false;
  private redoFlag = false;
  private listeners = new Set<() => void>();

  constructor(private readonly port: MessagePort) {
    this.port.onmessage = (e: MessageEvent<WorkerToClient>) => this.onMessage(e.data);
  }

  connect(): void {
    this.port.start?.();
    this.send({ kind: 'hello' });
  }

  getState(): Project {
    if (!this.state) {
      throw new Error('ClientBridge: state not yet received (call connect() and await snapshot)');
    }
    return this.state;
  }

  canUndo(): boolean {
    return this.undoFlag;
  }

  canRedo(): boolean {
    return this.redoFlag;
  }

  dispatch(action: Action): void {
    this.send({ kind: 'dispatch', action });
  }

  undo(): void {
    this.send({ kind: 'undo' });
  }

  redo(): void {
    this.send({ kind: 'redo' });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private send(msg: ClientToWorker): void {
    this.port.postMessage(msg);
  }

  private onMessage(msg: WorkerToClient): void {
    switch (msg.kind) {
      case 'snapshot':
        this.state = msg.state;
        this.notify();
        return;
      case 'patch':
        if (!this.state) return;
        this.state = applyPatches(this.state, msg.patches);
        this.notify();
        return;
      case 'history-changed':
        this.undoFlag = msg.canUndo;
        this.redoFlag = msg.canRedo;
        this.notify();
        return;
    }
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}
