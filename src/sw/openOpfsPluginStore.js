/**
 * Open (or create) the OPFS plugin store at `/plugins/`. Shared between
 * main.jsx (first-boot seeding) and App.jsx (installer + uninstall).
 *
 * Returns `null` on browsers without the File System Access API.
 */
import { OpfsPluginStore } from './OpfsPluginStore';

export async function openOpfsPluginStore() {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  const root = await navigator.storage.getDirectory();
  const pluginsRoot = await root.getDirectoryHandle('plugins', { create: true });
  return new OpfsPluginStore(pluginsRoot);
}
