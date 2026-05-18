import { parseManifest, type PluginManifest } from './PluginManifest';

export interface PluginRegistryEntry {
  manifest: PluginManifest;
  module: WebAssembly.Module;
  /** Map of relative UI path → asset bytes. Empty if the plugin ships no UI. */
  uiAssets: Map<string, Uint8Array>;
}

/**
 * Catalog of installed plugins, keyed by manifest id.
 * The registry is main-thread state; instantiation happens elsewhere
 * (PluginHost on the main thread, PluginInstance in the worklet).
 */
export class PluginRegistry {
  private readonly entries = new Map<string, PluginRegistryEntry>();

  install(entry: PluginRegistryEntry): void {
    if (this.entries.has(entry.manifest.id)) {
      throw new Error(`PluginRegistry: ${entry.manifest.id} already installed`);
    }
    this.entries.set(entry.manifest.id, entry);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): PluginRegistryEntry {
    const e = this.entries.get(id);
    if (!e) throw new Error(`PluginRegistry: ${id} not installed`);
    return e;
  }

  list(): PluginRegistryEntry[] {
    return [...this.entries.values()];
  }

  /**
   * Fetch and compile a built-in plugin from a folder URL.
   * Layout: `<baseUrl>/plugin.json`, `<baseUrl>/plugin.wasm`, optional `<baseUrl>/ui/<entry>`.
   *
   * Vite serves `src/builtin-plugins/<id>/*` as-is during dev. For production builds we
   * configure Vite to copy these into the dist; that wiring lives in a later task.
   */
  static async loadBuiltin(baseUrl: string): Promise<PluginRegistryEntry> {
    const manifestRes = await fetch(`${baseUrl}/plugin.json`);
    if (!manifestRes.ok) {
      throw new Error(`PluginRegistry.loadBuiltin: manifest fetch failed (${manifestRes.status}) for ${baseUrl}`);
    }
    const manifest = parseManifest(await manifestRes.json());

    const wasmRes = await fetch(`${baseUrl}/plugin.wasm`);
    if (!wasmRes.ok) {
      throw new Error(`PluginRegistry.loadBuiltin: wasm fetch failed (${wasmRes.status}) for ${baseUrl}`);
    }
    const module = await WebAssembly.compileStreaming(wasmRes);

    const uiAssets = new Map<string, Uint8Array>();
    if (manifest.ui) {
      const uiRes = await fetch(`${baseUrl}/ui/${manifest.ui.entry}`);
      if (!uiRes.ok) {
        throw new Error(`PluginRegistry.loadBuiltin: ui fetch failed (${uiRes.status}) for ${baseUrl}`);
      }
      uiAssets.set(manifest.ui.entry, new Uint8Array(await uiRes.arrayBuffer()));
    }

    return { manifest, module, uiAssets };
  }
}
