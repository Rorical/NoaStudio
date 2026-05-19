import type { Project } from './projectModel';

const PROJECT_FILE = 'project.json';

export class DebouncedSaver<T> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: { value: T } | null = null;

  constructor(
    private readonly save: (value: T) => Promise<void>,
    private readonly delayMs: number,
  ) {}

  schedule(value: T): void {
    this.pending = { value };
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const v = this.pending?.value;
      this.pending = null;
      if (v !== undefined) void this.save(v);
    }, this.delayMs);
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending) {
      const v = this.pending.value;
      this.pending = null;
      await this.save(v);
    }
  }
}

export class OpfsProjectStore {
  private rootPromise: Promise<FileSystemDirectoryHandle> | null = null;

  /**
   * Optionally inject a pre-resolved root handle (Node tests pass in a fake
   * implementing the File System Access API). Production callers pass no
   * arguments and the store reads `navigator.storage.getDirectory()` lazily.
   */
  constructor(rootHandle?: FileSystemDirectoryHandle | Promise<FileSystemDirectoryHandle>) {
    if (rootHandle) {
      this.rootPromise = Promise.resolve(rootHandle);
    }
  }

  private async root(): Promise<FileSystemDirectoryHandle> {
    if (!this.rootPromise) {
      this.rootPromise = navigator.storage.getDirectory();
    }
    return this.rootPromise;
  }

  async read(): Promise<Project | null> {
    try {
      const root = await this.root();
      const handle = await root.getFileHandle(PROJECT_FILE);
      const file = await handle.getFile();
      const text = await file.text();
      return JSON.parse(text) as Project;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'NotFoundError') return null;
      throw e;
    }
  }

  async write(project: Project): Promise<void> {
    const root = await this.root();
    const handle = await root.getFileHandle(PROJECT_FILE, { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(project));
    await writable.close();
  }
}
