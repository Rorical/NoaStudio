/**
 * Open (or create) the OPFS sample store at `/samples/`, where imported audio
 * PCM is persisted so it survives a reload. Returns `null` on browsers without
 * the File System Access API.
 */
import { SampleStore } from './SampleStore';

export async function openSampleStore() {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  const root = await navigator.storage.getDirectory();
  const samplesRoot = await root.getDirectoryHandle('samples', { create: true });
  return new SampleStore(samplesRoot);
}
