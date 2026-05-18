/**
 * Read/write installed plugins inside the OPFS subdirectory `plugins/`.
 *
 * Layout:
 *   <root>/<pluginId>/<version>/plugin.json
 *   <root>/<pluginId>/<version>/plugin.wasm
 *   <root>/<pluginId>/<version>/ui/<path>
 *
 * The root handle is the `plugins` directory (not the OPFS root). The SW
 * fetches `navigator.storage.getDirectory()` and passes `getDirectoryHandle('plugins', {create: true})`.
 */
export interface PluginInstallSpec {
  pluginId: string;
  version: string;
  /** Map of relative path → bytes. Paths must not contain `..` or start with `/`. */
  files: Map<string, Uint8Array>;
}

export interface InstalledPluginRecord {
  pluginId: string;
  version: string;
}

function assertSafePath(path: string): void {
  if (path.startsWith('/') || path.includes('..') || path.includes('\\')) {
    throw new Error(`OpfsPluginStore: unsafe path '${path}'`);
  }
  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '..') {
      throw new Error(`OpfsPluginStore: unsafe path '${path}'`);
    }
  }
}

export class OpfsPluginStore {
  constructor(private readonly root: FileSystemDirectoryHandle) {}

  /**
   * Write a plugin to OPFS. If the destination already exists, it's wiped first
   * so the new contents are clean. Not crash-safe — a process death mid-install
   * leaves a partial directory; the next `list()` will surface it. Future
   * versions will add a staging directory for atomic installs.
   */
  async install(spec: PluginInstallSpec): Promise<void> {
    for (const path of spec.files.keys()) assertSafePath(path);
    // Remove any prior install of this plugin id so the contents are replaced
    // rather than merged.
    await this.removePluginRoot(spec.pluginId);
    const pluginDir = await this.root.getDirectoryHandle(spec.pluginId, { create: true });
    const versionDir = await pluginDir.getDirectoryHandle(spec.version, { create: true });
    for (const [path, bytes] of spec.files) {
      await this.writeNested(versionDir, path, bytes);
    }
  }

  async readFile(pluginId: string, version: string, path: string): Promise<Uint8Array | null> {
    assertSafePath(path);
    const pluginDir = await this.safeGetDir(this.root, pluginId);
    if (!pluginDir) return null;
    const versionDir = await this.safeGetDir(pluginDir, version);
    if (!versionDir) return null;
    return this.readNested(versionDir, path);
  }

  async list(): Promise<InstalledPluginRecord[]> {
    const out: InstalledPluginRecord[] = [];
    for await (const [pluginId, handle] of (this.root as unknown as {
      entries(): AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>;
    }).entries()) {
      if (handle.kind !== 'directory') continue;
      const pluginDir = handle as FileSystemDirectoryHandle;
      for await (const [version, vhandle] of (pluginDir as unknown as {
        entries(): AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>;
      }).entries()) {
        if (vhandle.kind !== 'directory') continue;
        out.push({ pluginId, version });
      }
    }
    return out;
  }

  async remove(pluginId: string, version: string): Promise<void> {
    const pluginDir = await this.safeGetDir(this.root, pluginId);
    if (!pluginDir) return;
    try {
      await pluginDir.removeEntry(version, { recursive: true });
    } catch (err) {
      if ((err as { name?: string })?.name === 'NotFoundError') return;
      throw err;
    }
    // If the pluginId dir is now empty, drop it too.
    let empty = true;
    for await (const _ of (pluginDir as unknown as { keys(): AsyncIterableIterator<string> }).keys()) {
      empty = false; break;
    }
    if (empty) {
      try { await this.root.removeEntry(pluginId, { recursive: true }); } catch { /* ignore */ }
    }
  }

  private async removePluginRoot(pluginId: string): Promise<void> {
    try {
      await this.root.removeEntry(pluginId, { recursive: true });
    } catch (err) {
      if ((err as { name?: string })?.name === 'NotFoundError') return;
      throw err;
    }
  }

  private async safeGetDir(
    parent: FileSystemDirectoryHandle,
    name: string,
  ): Promise<FileSystemDirectoryHandle | null> {
    try {
      return await parent.getDirectoryHandle(name);
    } catch (err) {
      if ((err as { name?: string })?.name === 'NotFoundError') return null;
      throw err;
    }
  }

  private async writeNested(
    dir: FileSystemDirectoryHandle,
    path: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const parts = path.split('/');
    let cursor = dir;
    for (let i = 0; i < parts.length - 1; i++) {
      cursor = await cursor.getDirectoryHandle(parts[i]!, { create: true });
    }
    const fileName = parts[parts.length - 1]!;
    const file = await cursor.getFileHandle(fileName, { create: true });
    const writable = await file.createWritable();
    // Force a strict ArrayBuffer view so OPFS' WritableFileStream accepts it
    // even when the input Uint8Array is backed by a SharedArrayBuffer.
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    await writable.write(ab);
    await writable.close();
  }

  private async readNested(
    dir: FileSystemDirectoryHandle,
    path: string,
  ): Promise<Uint8Array | null> {
    const parts = path.split('/');
    let cursor: FileSystemDirectoryHandle = dir;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = await this.safeGetDir(cursor, parts[i]!);
      if (!next) return null;
      cursor = next;
    }
    const fileName = parts[parts.length - 1]!;
    let file: FileSystemFileHandle;
    try {
      file = await cursor.getFileHandle(fileName);
    } catch (err) {
      if ((err as { name?: string })?.name === 'NotFoundError') return null;
      throw err;
    }
    const f = await file.getFile();
    return new Uint8Array(await f.arrayBuffer());
  }
}
