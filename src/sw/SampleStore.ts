/**
 * Persist decoded audio samples in OPFS so imported audio survives a reload.
 *
 * Layout: `<root>/<sampleId>/pcm.bin`, where `pcm.bin` is a 12-byte header
 * (3×u32 little-endian: channels, frames, sampleRate) followed by interleaved
 * Float32 PCM. The root handle is the `samples` directory (not the OPFS root).
 *
 * The encode/decode functions are pure (no OPFS) and carry the bulk of the
 * logic so they're unit-testable in Node; the store is a thin I/O wrapper.
 */
export interface SampleData {
  /** Interleaved PCM: frame f, channel c at pcm[f * channels + c]. */
  pcm: Float32Array;
  channels: number;
  frames: number;
  sampleRate: number;
}

const HEADER_BYTES = 12; // 3 × u32: channels, frames, sampleRate

export function encodeSample(d: SampleData): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + d.pcm.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, d.channels, true);
  view.setUint32(4, d.frames, true);
  view.setUint32(8, d.sampleRate, true);
  out.set(new Uint8Array(d.pcm.buffer, d.pcm.byteOffset, d.pcm.byteLength), HEADER_BYTES);
  return out;
}

export function decodeSample(bytes: Uint8Array): SampleData {
  if (bytes.byteLength < HEADER_BYTES) {
    throw new Error('SampleStore: truncated sample blob');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = view.getUint32(0, true);
  const frames = view.getUint32(4, true);
  const sampleRate = view.getUint32(8, true);
  // Validate the header against the actual PCM payload so a truncated/corrupt
  // blob can't produce a too-short PCM array with a large `frames` (which would
  // let the worklet's playback cursor read past the end → NaN in the mix).
  const pcmBytes = bytes.subarray(HEADER_BYTES);
  if (channels < 1 || pcmBytes.byteLength < frames * channels * 4) {
    throw new Error('SampleStore: corrupt sample blob (header/payload mismatch)');
  }
  // Copy the PCM region into its own (4-byte-aligned) buffer — the source may be
  // an unaligned subview.
  const pcm = new Float32Array(frames * channels);
  new Uint8Array(pcm.buffer).set(pcmBytes.subarray(0, pcm.byteLength));
  return { pcm, channels, frames, sampleRate };
}

function assertSafeId(id: string): void {
  if (id === '.' || id === '..' || !/^[A-Za-z0-9_.-]+$/.test(id)) {
    throw new Error(`SampleStore: unsafe sample id '${id}'`);
  }
}

export class SampleStore {
  constructor(private readonly root: FileSystemDirectoryHandle) {}

  async write(id: string, data: SampleData): Promise<void> {
    assertSafeId(id);
    const dir = await this.root.getDirectoryHandle(id, { create: true });
    const file = await dir.getFileHandle('pcm.bin', { create: true });
    const writable = await file.createWritable();
    const bytes = encodeSample(data);
    // Strict ArrayBuffer copy so OPFS' WritableFileStream accepts it even when
    // the input is backed by a SharedArrayBuffer.
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    await writable.write(ab);
    await writable.close();
  }

  async read(id: string): Promise<SampleData | null> {
    assertSafeId(id);
    const dir = await this.safeGetDir(id);
    if (!dir) return null;
    let file: FileSystemFileHandle;
    try {
      file = await dir.getFileHandle('pcm.bin');
    } catch (err) {
      if ((err as { name?: string })?.name === 'NotFoundError') return null;
      throw err;
    }
    const f = await file.getFile();
    return decodeSample(new Uint8Array(await f.arrayBuffer()));
  }

  async has(id: string): Promise<boolean> {
    assertSafeId(id);
    const dir = await this.safeGetDir(id);
    if (!dir) return false;
    try {
      await dir.getFileHandle('pcm.bin');
      return true;
    } catch {
      return false;
    }
  }

  async remove(id: string): Promise<void> {
    assertSafeId(id);
    try {
      await this.root.removeEntry(id, { recursive: true });
    } catch (err) {
      if ((err as { name?: string })?.name === 'NotFoundError') return;
      throw err;
    }
  }

  async list(): Promise<string[]> {
    const out: string[] = [];
    for await (const [name, handle] of (this.root as unknown as {
      entries(): AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>;
    }).entries()) {
      if (handle.kind === 'directory') out.push(name);
    }
    return out;
  }

  private async safeGetDir(name: string): Promise<FileSystemDirectoryHandle | null> {
    try {
      return await this.root.getDirectoryHandle(name);
    } catch (err) {
      if ((err as { name?: string })?.name === 'NotFoundError') return null;
      throw err;
    }
  }
}
