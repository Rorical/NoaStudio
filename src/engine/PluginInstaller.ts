/**
 * Fetches a `.noaplugin` ZIP from a URL, validates it, unpacks into the OPFS
 * plugin store, and dispatches `INSTALL_PLUGIN` to the coordinator. See the
 * Phase 5 design doc (Section 5) for the ZIP format + validation rules.
 *
 * Wired by the main thread once the coordinator bridge + OPFS store are
 * available. Pure logic — no DOM, no globals beyond `fetch` and `crypto`
 * (both injectable via deps for tests).
 */
import { unzipSync } from 'fflate';
import { parseManifest } from './PluginManifest';
import type { OpfsPluginStore } from '../sw/OpfsPluginStore';
import type { Action } from '../coordinator/actions';

const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_FILE_COUNT = 1000;

type SriAlgo = 'SHA-256' | 'SHA-384' | 'SHA-512';

export interface PluginInstallerDeps {
  fetch: typeof globalThis.fetch;
  store: OpfsPluginStore;
  dispatch: (action: Action) => void;
}

export interface InstalledPluginRecord {
  pluginId: string;
  version: string;
  name: string;
  kind: 'gen' | 'fx';
}

export class PluginInstaller {
  constructor(private readonly deps: PluginInstallerDeps) {}

  async installFromUrl(url: string): Promise<InstalledPluginRecord> {
    const parsed = new URL(url);
    const sri = parseSri(parsed.hash);

    const res = await this.deps.fetch(url);
    if (!res.ok) throw new Error(`PluginInstaller: fetch failed (${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());

    if (sri) {
      const actual = await computeSriHash(sri.algo, bytes);
      if (actual !== sri.b64) {
        throw new Error('PluginInstaller: SRI hash mismatch');
      }
    }

    const entries = unzipSync(bytes);
    validatePaths(entries);
    validateSize(entries);

    const manifestBytes = entries['plugin.json'];
    if (!manifestBytes) throw new Error('PluginInstaller: missing plugin.json');
    let manifestRaw: unknown;
    try {
      manifestRaw = JSON.parse(new TextDecoder().decode(manifestBytes));
    } catch {
      throw new Error('PluginInstaller: plugin.json is not valid JSON');
    }
    const manifest = parseManifest(manifestRaw);

    const wasmBytes = entries['plugin.wasm'];
    if (!wasmBytes) throw new Error('PluginInstaller: missing plugin.wasm');
    const wasmBuf = new ArrayBuffer(wasmBytes.byteLength);
    new Uint8Array(wasmBuf).set(wasmBytes);
    if (!WebAssembly.validate(wasmBuf)) {
      throw new Error('PluginInstaller: plugin.wasm did not validate');
    }

    if (manifest.ui) {
      const entryPath = 'ui/' + manifest.ui.entry;
      if (!entries[entryPath]) {
        throw new Error(`PluginInstaller: manifest.ui.entry '${entryPath}' missing from ZIP`);
      }
    }

    const files = new Map<string, Uint8Array>();
    for (const [path, fileBytes] of Object.entries(entries)) {
      files.set(path, fileBytes);
    }
    await this.deps.store.install({
      pluginId: manifest.id,
      version: manifest.version,
      files,
    });

    const record: InstalledPluginRecord = {
      pluginId: manifest.id,
      version: manifest.version,
      name: manifest.name,
      kind: manifest.kind,
    };
    this.deps.dispatch({ type: 'INSTALL_PLUGIN', entry: record });
    return record;
  }
}

function parseSri(hash: string): { algo: SriAlgo; b64: string } | null {
  if (!hash) return null;
  const m = hash.replace(/^#/, '').match(/^(sha256|sha384|sha512)-(.+)$/i);
  if (!m) return null;
  const algos: Record<string, SriAlgo> = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };
  return { algo: algos[m[1]!.toLowerCase()]!, b64: m[2]! };
}

async function computeSriHash(algo: SriAlgo, bytes: Uint8Array): Promise<string> {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const buf = await crypto.subtle.digest(algo, ab);
  return arrayBufferToBase64(buf);
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  let s = '';
  const arr = new Uint8Array(buf);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]!);
  return btoa(s);
}

function validatePaths(entries: Record<string, Uint8Array>): void {
  for (const path of Object.keys(entries)) {
    if (path.startsWith('/') || path.includes('\\')) {
      throw new Error(`PluginInstaller: unsafe path '${path}'`);
    }
    for (const segment of path.split('/')) {
      if (segment === '.' || segment === '..') {
        throw new Error(`PluginInstaller: unsafe path '${path}'`);
      }
    }
  }
}

function validateSize(entries: Record<string, Uint8Array>): void {
  const fileCount = Object.keys(entries).length;
  if (fileCount > MAX_FILE_COUNT) {
    throw new Error(`PluginInstaller: too many files (${fileCount} > ${MAX_FILE_COUNT})`);
  }
  let totalBytes = 0;
  for (const b of Object.values(entries)) totalBytes += b.byteLength;
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error(`PluginInstaller: ZIP too large (${totalBytes} > ${MAX_TOTAL_BYTES})`);
  }
}
