import type { MessagePortLike } from './WorkletProtocol';
import type { PluginManifest } from './PluginManifest';

export interface PluginWorkerSpawnArgs {
  instanceId: string;
  module: WebAssembly.Module;
  manifest: PluginManifest;
  sampleRate: number;
  maxBlockSize: number;
}

export interface PreparedPreset {
  handle: number;
  stateBytes: Uint8Array;
}

interface PendingSpawn {
  resolve: () => void;
  reject: (e: Error) => void;
}

interface PendingPrepare {
  resolve: (r: PreparedPreset) => void;
  reject: (e: Error) => void;
}

type WorkerOutbound =
  | { type: 'READY' }
  | { type: 'PRESET_PREPARED'; requestId: string; handle: number; stateBytes: Uint8Array }
  | { type: 'PRESET_PREPARE_FAILED'; requestId: string; error: string }
  | { type: string; [k: string]: unknown };

/**
 * Main-thread façade over a per-plugin-instance Worker.
 *
 * Mirrors the WorkletProtocol pattern: takes any `MessagePortLike` so unit
 * tests can drive it with a hand-rolled port; in production callers wire
 * `worker.port` from a `Worker` constructed with `{ type: 'module' }`.
 *
 * Protocol:
 *   host → worker:  HELLO, PREPARE_PRESET, FREE_PRESET
 *   worker → host:  READY, PRESET_PREPARED, PRESET_PREPARE_FAILED
 */
export class PluginWorker {
  private readonly pendingPreset = new Map<string, PendingPrepare>();
  private pendingSpawn: PendingSpawn | null = null;
  private spawned = false;
  private spawnStarted = false;
  private disposed = false;
  private nextRequestId = 0;

  constructor(private readonly port: MessagePortLike) {
    port.onmessage = (e: MessageEvent) => this.handle(e.data);
  }

  spawn(args: PluginWorkerSpawnArgs): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('PluginWorker: disposed'));
        return;
      }
      if (this.spawnStarted) {
        reject(new Error(`PluginWorker: already spawned (${args.instanceId})`));
        return;
      }
      this.spawnStarted = true;
      this.pendingSpawn = { resolve, reject };
      this.port.postMessage({
        type: 'HELLO',
        instanceId: args.instanceId,
        module: args.module,
        manifest: args.manifest,
        sampleRate: args.sampleRate,
        maxBlockSize: args.maxBlockSize,
      });
    });
  }

  preparePreset(bytes: Uint8Array): Promise<PreparedPreset> {
    if (this.disposed) return Promise.reject(new Error('PluginWorker: disposed'));
    if (!this.spawned) throw new Error('PluginWorker.preparePreset: worker not spawned');
    return new Promise<PreparedPreset>((resolve, reject) => {
      const requestId = `r${++this.nextRequestId}`;
      this.pendingPreset.set(requestId, { resolve, reject });
      this.port.postMessage({ type: 'PREPARE_PRESET', requestId, bytes });
    });
  }

  freePreset(handle: number): void {
    if (this.disposed || !this.spawned) return;
    this.port.postMessage({ type: 'FREE_PRESET', handle });
  }

  /** Reject pending promises; subsequent calls are inert. Does NOT terminate the underlying Worker — that's the caller's responsibility. */
  dispose(reason: Error = new Error('PluginWorker: disposed')): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pendingSpawn) {
      this.pendingSpawn.reject(reason);
      this.pendingSpawn = null;
    }
    for (const p of this.pendingPreset.values()) p.reject(reason);
    this.pendingPreset.clear();
  }

  private handle(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const msg = data as WorkerOutbound;
    switch (msg.type) {
      case 'READY': {
        if (!this.pendingSpawn) return;
        this.spawned = true;
        const { resolve } = this.pendingSpawn;
        this.pendingSpawn = null;
        resolve();
        return;
      }
      case 'PRESET_PREPARED': {
        const p = this.pendingPreset.get(msg.requestId as string);
        if (!p) return;
        this.pendingPreset.delete(msg.requestId as string);
        p.resolve({
          handle: msg.handle as number,
          stateBytes: msg.stateBytes as Uint8Array,
        });
        return;
      }
      case 'PRESET_PREPARE_FAILED': {
        const p = this.pendingPreset.get(msg.requestId as string);
        if (!p) return;
        this.pendingPreset.delete(msg.requestId as string);
        p.reject(new Error(`PluginWorker.preparePreset: ${msg.error}`));
        return;
      }
    }
  }
}
