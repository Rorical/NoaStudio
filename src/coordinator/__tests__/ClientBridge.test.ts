import { describe, it, expect } from 'vitest';
import { ClientBridge } from '../ClientBridge';
import { seedProject } from '../projectModel';
import type { ClientToWorker, WorkerToClient } from '../protocol';

function makePair() {
  const channel = new MessageChannel();
  const bridge = new ClientBridge(channel.port1);
  const sent: ClientToWorker[] = [];
  channel.port2.onmessage = (e) => sent.push(e.data as ClientToWorker);
  channel.port2.start();
  function send(msg: WorkerToClient): void {
    channel.port2.postMessage(msg);
  }
  return { bridge, sent, send };
}

describe('ClientBridge', () => {
  it('sends a hello on connect()', async () => {
    const { bridge, sent } = makePair();
    bridge.connect();
    await new Promise((r) => setTimeout(r, 5));
    expect(sent[0]).toEqual({ kind: 'hello' });
  });

  it('captures snapshot and exposes via getState()', async () => {
    const { bridge, send } = makePair();
    bridge.connect();
    const seed = seedProject();
    send({ kind: 'snapshot', state: seed });
    await new Promise((r) => setTimeout(r, 5));
    expect(bridge.getState()).toEqual(seed);
  });

  it('applies a patch and runs subscribers', async () => {
    const { bridge, send } = makePair();
    bridge.connect();
    send({ kind: 'snapshot', state: seedProject() });
    await new Promise((r) => setTimeout(r, 5));
    let calls = 0;
    bridge.subscribe(() => { calls++; });
    send({ kind: 'patch', patches: [{ op: 'replace', path: ['bpm'], value: 200 }], sourcePortId: 0 });
    await new Promise((r) => setTimeout(r, 5));
    expect(bridge.getState().bpm).toBe(200);
    expect(calls).toBe(1);
  });

  it('dispatch posts a Dispatch message', async () => {
    const { bridge, sent } = makePair();
    bridge.connect();
    await new Promise((r) => setTimeout(r, 5));
    bridge.dispatch({ type: 'SET_BPM', bpm: 140 });
    await new Promise((r) => setTimeout(r, 5));
    expect(sent.find((m) => m.kind === 'dispatch')).toEqual({
      kind: 'dispatch',
      action: { type: 'SET_BPM', bpm: 140 },
    });
  });

  it('undo and redo post the respective messages', async () => {
    const { bridge, sent } = makePair();
    bridge.connect();
    bridge.undo();
    bridge.redo();
    await new Promise((r) => setTimeout(r, 5));
    const kinds = sent.map((m) => m.kind);
    expect(kinds).toContain('undo');
    expect(kinds).toContain('redo');
  });

  it('history-changed updates canUndo/canRedo', async () => {
    const { bridge, send } = makePair();
    bridge.connect();
    send({ kind: 'history-changed', canUndo: true, canRedo: false });
    await new Promise((r) => setTimeout(r, 5));
    expect(bridge.canUndo()).toBe(true);
    expect(bridge.canRedo()).toBe(false);
  });

  it('subscribe returns an unsubscribe fn', async () => {
    const { bridge, send } = makePair();
    bridge.connect();
    send({ kind: 'snapshot', state: seedProject() });
    await new Promise((r) => setTimeout(r, 5));
    let calls = 0;
    const off = bridge.subscribe(() => { calls++; });
    send({ kind: 'patch', patches: [{ op: 'replace', path: ['bpm'], value: 100 }], sourcePortId: 0 });
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toBe(1);
    off();
    send({ kind: 'patch', patches: [{ op: 'replace', path: ['bpm'], value: 200 }], sourcePortId: 0 });
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toBe(1);
  });

  it('initial getState returns a freshly-seeded project before any snapshot', () => {
    // No connect call — getState should still work and return the seed.
    const channel = new MessageChannel();
    const bridge = new ClientBridge(channel.port1);
    expect(bridge.getState().schemaVersion).toBe(seedProject().schemaVersion);
  });

  it('initial canUndo/canRedo default to false', () => {
    const channel = new MessageChannel();
    const bridge = new ClientBridge(channel.port1);
    expect(bridge.canUndo()).toBe(false);
    expect(bridge.canRedo()).toBe(false);
  });

  it('multiple subscribers all fire on a patch', async () => {
    const { bridge, send } = makePair();
    bridge.connect();
    send({ kind: 'snapshot', state: seedProject() });
    await new Promise((r) => setTimeout(r, 5));
    let a = 0, b = 0, c = 0;
    bridge.subscribe(() => { a++; });
    bridge.subscribe(() => { b++; });
    bridge.subscribe(() => { c++; });
    send({ kind: 'patch', patches: [{ op: 'replace', path: ['bpm'], value: 150 }], sourcePortId: 0 });
    await new Promise((r) => setTimeout(r, 5));
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(c).toBe(1);
  });

  it('snapshot notifies subscribers', async () => {
    const { bridge, send } = makePair();
    bridge.connect();
    let calls = 0;
    bridge.subscribe(() => { calls++; });
    send({ kind: 'snapshot', state: seedProject() });
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toBe(1);
  });

  it('history-changed notifies subscribers', async () => {
    const { bridge, send } = makePair();
    bridge.connect();
    let calls = 0;
    bridge.subscribe(() => { calls++; });
    send({ kind: 'history-changed', canUndo: true, canRedo: true });
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toBe(1);
    expect(bridge.canUndo()).toBe(true);
    expect(bridge.canRedo()).toBe(true);
  });

  it('multiple patches apply in order', async () => {
    const { bridge, send } = makePair();
    bridge.connect();
    send({ kind: 'snapshot', state: seedProject() });
    await new Promise((r) => setTimeout(r, 5));
    send({ kind: 'patch', patches: [{ op: 'replace', path: ['bpm'], value: 100 }], sourcePortId: 0 });
    send({ kind: 'patch', patches: [{ op: 'replace', path: ['bpm'], value: 200 }], sourcePortId: 0 });
    send({ kind: 'patch', patches: [{ op: 'replace', path: ['bpm'], value: 175 }], sourcePortId: 0 });
    await new Promise((r) => setTimeout(r, 5));
    expect(bridge.getState().bpm).toBe(175);
  });
});
