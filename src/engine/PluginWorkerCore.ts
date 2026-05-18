import { PluginInstance } from './PluginInstance';
import type { PluginManifest } from './PluginManifest';

interface HelloMessage {
  type: 'HELLO';
  instanceId: string;
  /** Raw WASM bytes — worker compiles synchronously in its own context. */
  wasm: Uint8Array;
  manifest: PluginManifest;
  sampleRate: number;
  maxBlockSize: number;
}

interface PreparePresetMessage {
  type: 'PREPARE_PRESET';
  requestId: string;
  bytes: Uint8Array;
}

interface FreePresetMessage {
  type: 'FREE_PRESET';
  handle: number;
}

type Inbound = HelloMessage | PreparePresetMessage | FreePresetMessage;

export type WorkerReply = (msg: unknown) => void;

/**
 * Platform-agnostic message handler for the per-instance plugin worker.
 *
 * The real worker module (`plugin-host.worker.ts`) wires `self.onmessage` to
 * an instance of this class. This factoring exists so Node-based unit tests
 * can drive the worker logic without spinning up `worker_threads`.
 */
export class PluginWorkerCore {
  private instance: PluginInstance | null = null;
  private destroyed = false;

  handle(data: unknown, reply: WorkerReply): void {
    if (this.destroyed) return;
    if (!data || typeof data !== 'object') return;
    const msg = data as Inbound;
    switch (msg.type) {
      case 'HELLO':
        this.handleHello(msg, reply);
        return;
      case 'PREPARE_PRESET':
        this.handlePrepare(msg, reply);
        return;
      case 'FREE_PRESET':
        if (this.instance && this.instance.hasPresetSupport()) {
          this.instance.freePreset(msg.handle);
        }
        return;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.instance) {
      this.instance.destroy();
      this.instance = null;
    }
  }

  private handleHello(msg: HelloMessage, reply: WorkerReply): void {
    if (this.instance) {
      reply({ type: 'PRESET_PREPARE_FAILED', requestId: '*', error: 'worker already initialized' });
      return;
    }
    try {
      const module = new WebAssembly.Module(msg.wasm as unknown as BufferSource);
      this.instance = PluginInstance.fromModule(module, msg.manifest, {
        sampleRate: msg.sampleRate,
        maxBlockSize: msg.maxBlockSize,
      });
      reply({ type: 'READY' });
    } catch (err) {
      reply({
        type: 'PRESET_PREPARE_FAILED',
        requestId: '*',
        error: `HELLO failed: ${(err as Error)?.message ?? err}`,
      });
    }
  }

  private handlePrepare(msg: PreparePresetMessage, reply: WorkerReply): void {
    if (!this.instance) {
      reply({
        type: 'PRESET_PREPARE_FAILED',
        requestId: msg.requestId,
        error: 'worker not initialized',
      });
      return;
    }
    if (!this.instance.hasPresetSupport()) {
      reply({
        type: 'PRESET_PREPARE_FAILED',
        requestId: msg.requestId,
        error: 'plugin has no preset support',
      });
      return;
    }
    try {
      const handle = this.instance.preparePreset(msg.bytes);
      const stateBytes = this.instance.serializePreset(handle);
      reply({ type: 'PRESET_PREPARED', requestId: msg.requestId, handle, stateBytes });
    } catch (err) {
      reply({
        type: 'PRESET_PREPARE_FAILED',
        requestId: msg.requestId,
        error: (err as Error)?.message ?? String(err),
      });
    }
  }
}
