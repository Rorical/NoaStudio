/// <reference lib="webworker" />
import { applyPatches } from 'immer';
import { applyAction } from './reducer';
import { HistoryStack } from './history';
import { seedProject, type Project } from './projectModel';
import { OpfsProjectStore, DebouncedSaver } from './persistence';
import type { ClientToWorker, WorkerToClient } from './protocol';
import type { Action } from './actions';

declare const self: SharedWorkerGlobalScope;

let state: Project = seedProject();
const history = new HistoryStack();
const store = new OpfsProjectStore();
const saver = new DebouncedSaver<Project>(async (p) => {
  try {
    await store.write(p);
  } catch (e) {
    console.error('[coordinator] OPFS write failed', e);
  }
}, 250);

const ports = new Set<MessagePort>();
let nextPortId = 1;
const portIds = new WeakMap<MessagePort, number>();

void (async () => {
  try {
    const persisted = await store.read();
    if (persisted) state = persisted;
  } catch (e) {
    console.error('[coordinator] OPFS read failed; using seed', e);
  }
})();

function broadcast(msg: WorkerToClient): void {
  for (const p of ports) p.postMessage(msg);
}

function sendHistoryChanged(): void {
  broadcast({ kind: 'history-changed', canUndo: history.canUndo(), canRedo: history.canRedo() });
}

function handleDispatch(action: Action, sourcePortId: number): void {
  const [next, patches, inversePatches] = applyAction(state, action);
  if (patches.length === 0) return;
  state = next;
  history.push({ patches: [...patches], inversePatches: [...inversePatches] });
  saver.schedule(state);
  broadcast({ kind: 'patch', patches: [...patches], sourcePortId });
  sendHistoryChanged();
}

function handleUndo(): void {
  const result = history.undo();
  if (!result) return;
  state = applyPatches(state, result.patchesToApply);
  saver.schedule(state);
  broadcast({ kind: 'patch', patches: result.patchesToApply, sourcePortId: 0 });
  sendHistoryChanged();
}

function handleRedo(): void {
  const result = history.redo();
  if (!result) return;
  state = applyPatches(state, result.patchesToApply);
  saver.schedule(state);
  broadcast({ kind: 'patch', patches: result.patchesToApply, sourcePortId: 0 });
  sendHistoryChanged();
}

self.onconnect = (event: MessageEvent) => {
  const port = (event as unknown as { ports: MessagePort[] }).ports[0]!;
  const id = nextPortId++;
  portIds.set(port, id);
  ports.add(port);

  port.onmessage = (e: MessageEvent<ClientToWorker>) => {
    const msg = e.data;
    switch (msg.kind) {
      case 'hello':
        port.postMessage({ kind: 'snapshot', state } satisfies WorkerToClient);
        port.postMessage({ kind: 'history-changed', canUndo: history.canUndo(), canRedo: history.canRedo() } satisfies WorkerToClient);
        return;
      case 'dispatch':
        handleDispatch(msg.action, id);
        return;
      case 'undo':
        handleUndo();
        return;
      case 'redo':
        handleRedo();
        return;
    }
  };

  port.start();
};
