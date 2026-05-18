import type { PluginManifest } from './PluginManifest';

/**
 * Minimum surface we need from a MessagePort-shaped object. `AudioWorkletNode.port`
 * is a `MessagePort`; tests pass a hand-rolled stub with the same shape.
 */
export interface MessagePortLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
}

export interface LoadPluginArgs {
  /** Stable string id; matches the coordinator's PluginInstance.id. */
  instanceId: string;
  /** Slot index inside the worklet's signal chain. */
  slot: number;
  /**
   * Raw WASM bytes. The worklet compiles synchronously via
   * `new WebAssembly.Module(wasm)` because Module instances are not
   * structured-cloneable to AudioWorkletGlobalScope (crbug.com/1078182).
   */
  wasm: Uint8Array;
  manifest: PluginManifest;
  /** Optional initial param values; defaults to the plugin's manifest defaults if omitted. */
  initialParams?: number[];
}

export interface LoadPluginResult {
  instanceId: string;
  slot: number;
  paramRingSab: SharedArrayBuffer;
  notifyRingSab: SharedArrayBuffer;
}

interface PendingLoad {
  resolve: (r: LoadPluginResult) => void;
  reject: (e: Error) => void;
}

type WorkletOutbound =
  | { type: 'INSTANCE_READY'; instanceId: string; slot: number; paramRingSab: SharedArrayBuffer; notifyRingSab: SharedArrayBuffer }
  | { type: 'INSTANCE_ERROR'; instanceId: string; error: string }
  | { type: string; [k: string]: unknown };

/**
 * Main-thread side of the worklet control protocol.
 *
 * Owns the pending-load map keyed by `instanceId`. The audio worklet always echoes
 * the originating `instanceId` back in `INSTANCE_READY` / `INSTANCE_ERROR`, so the
 * protocol can match responses to requests without needing a separate correlation id.
 */
export class WorkletProtocol {
  private readonly pending = new Map<string, PendingLoad>();
  private disposed = false;

  constructor(private readonly port: MessagePortLike) {
    port.onmessage = (e: MessageEvent) => this.handle(e.data);
  }

  /**
   * Send INSTANTIATE_PLUGIN to the worklet and resolve once it replies with
   * INSTANCE_READY for the same `instanceId`.
   */
  loadPlugin(args: LoadPluginArgs): Promise<LoadPluginResult> {
    return new Promise<LoadPluginResult>((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('WorkletProtocol: disposed'));
        return;
      }
      if (this.pending.has(args.instanceId)) {
        reject(new Error(`WorkletProtocol: instanceId '${args.instanceId}' already pending`));
        return;
      }
      this.pending.set(args.instanceId, { resolve, reject });
      this.port.postMessage({
        type: 'INSTANTIATE_PLUGIN',
        instanceId: args.instanceId,
        slot: args.slot,
        wasm: args.wasm,
        manifest: args.manifest,
        ...(args.initialParams ? { initialParams: args.initialParams } : {}),
      });
    });
  }

  /**
   * Fire-and-forget removal. The worklet handles unknown slots as a no-op,
   * so callers don't need to coordinate with an INSTANCE_READY for the unload.
   */
  unloadInstance(slot: number): void {
    if (this.disposed) return;
    this.port.postMessage({ type: 'DESTROY_INSTANCE', slot });
  }

  /**
   * Apply a prepared preset's state bytes to the instance at `slot`. The
   * worklet calls `noa_set_state` between blocks — fast per the ABI v1.1
   * contract that set_state is O(memcpy + atomic indices).
   */
  applyPresetState(slot: number, stateBytes: Uint8Array): void {
    if (this.disposed) return;
    this.port.postMessage({ type: 'APPLY_PRESET_STATE', slot, stateBytes });
  }

  /** Reject every outstanding loadPlugin promise (used on EngineClient.dispose). */
  dispose(reason: Error = new Error('WorkletProtocol: disposed')): void {
    this.disposed = true;
    for (const p of this.pending.values()) p.reject(reason);
    this.pending.clear();
  }

  private handle(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const msg = data as WorkletOutbound;
    switch (msg.type) {
      case 'INSTANCE_READY': {
        const p = this.pending.get(msg.instanceId as string);
        if (!p) return;
        this.pending.delete(msg.instanceId as string);
        p.resolve({
          instanceId: msg.instanceId as string,
          slot: msg.slot as number,
          paramRingSab: msg.paramRingSab as SharedArrayBuffer,
          notifyRingSab: msg.notifyRingSab as SharedArrayBuffer,
        });
        return;
      }
      case 'INSTANCE_ERROR': {
        const p = this.pending.get(msg.instanceId as string);
        if (!p) return;
        this.pending.delete(msg.instanceId as string);
        p.reject(new Error(`worklet rejected '${msg.instanceId}': ${msg.error}`));
        return;
      }
    }
  }
}
