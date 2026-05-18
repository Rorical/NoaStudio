// Hand-rolled in-memory File System Access API stub. Just enough to drive
// OpfsPluginStore tests in Node — supports getDirectoryHandle, getFileHandle,
// createWritable, getFile, removeEntry, values, move.

class FakeWritableFileStream {
  constructor(private file: FakeFileHandle) {}
  async write(data: Uint8Array | ArrayBuffer | string): Promise<void> {
    if (typeof data === 'string') {
      this.file._bytes = new TextEncoder().encode(data);
    } else if (data instanceof Uint8Array) {
      this.file._bytes = new Uint8Array(data);
    } else {
      this.file._bytes = new Uint8Array(data);
    }
  }
  async close(): Promise<void> { /* no-op */ }
}

class FakeFile {
  constructor(public _bytes: Uint8Array) {}
  async arrayBuffer(): Promise<ArrayBuffer> {
    const ab = new ArrayBuffer(this._bytes.byteLength);
    new Uint8Array(ab).set(this._bytes);
    return ab;
  }
}

export class FakeFileHandle {
  readonly kind = 'file' as const;
  _bytes: Uint8Array = new Uint8Array(0);
  constructor(public name: string) {}
  async createWritable(): Promise<FakeWritableFileStream> {
    return new FakeWritableFileStream(this);
  }
  async getFile(): Promise<FakeFile> {
    return new FakeFile(this._bytes);
  }
}

export class FakeDirectoryHandle {
  readonly kind = 'directory' as const;
  private children = new Map<string, FakeDirectoryHandle | FakeFileHandle>();
  constructor(public name: string) {}

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDirectoryHandle> {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'directory') throw new TypeError('TypeMismatchError');
      return existing;
    }
    if (!opts?.create) throw new DOMException('NotFoundError', 'NotFoundError');
    const dir = new FakeDirectoryHandle(name);
    this.children.set(name, dir);
    return dir;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'file') throw new TypeError('TypeMismatchError');
      return existing;
    }
    if (!opts?.create) throw new DOMException('NotFoundError', 'NotFoundError');
    const file = new FakeFileHandle(name);
    this.children.set(name, file);
    return file;
  }

  async removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void> {
    if (!this.children.has(name)) throw new DOMException('NotFoundError', 'NotFoundError');
    const entry = this.children.get(name)!;
    if (entry.kind === 'directory' && !opts?.recursive) {
      const inner = (entry as FakeDirectoryHandle).children;
      if (inner.size > 0) throw new DOMException('InvalidModificationError', 'InvalidModificationError');
    }
    this.children.delete(name);
  }

  /** Async-iterable returning entries; spec: returns [name, handle] tuples via entries(). */
  async *entries(): AsyncGenerator<[string, FakeDirectoryHandle | FakeFileHandle]> {
    for (const [name, h] of this.children) yield [name, h];
  }

  async *keys(): AsyncGenerator<string> {
    for (const name of this.children.keys()) yield name;
  }

  async *values(): AsyncGenerator<FakeDirectoryHandle | FakeFileHandle> {
    for (const h of this.children.values()) yield h;
  }

  /**
   * Chromium-only: atomic move within OPFS. Used by stageAndInstall.
   * In our fake we splice the child into a new map under a new name.
   */
  async move(newName: string, parent?: FakeDirectoryHandle): Promise<void> {
    // Not implemented at the directory level — see _moveChild on parent below.
    throw new Error('Use parent._moveChild(oldName, newName) on the fake handle.');
  }

  /** Test-only helper to atomically rename a child of this directory. */
  _moveChild(oldName: string, newName: string, target?: FakeDirectoryHandle): void {
    const entry = this.children.get(oldName);
    if (!entry) throw new DOMException('NotFoundError', 'NotFoundError');
    const dest = target ?? this;
    if (dest.children.has(newName)) {
      // Overwrite existing — real OPFS move() replaces.
      dest.children.delete(newName);
    }
    this.children.delete(oldName);
    dest.children.set(newName, entry);
  }
}
