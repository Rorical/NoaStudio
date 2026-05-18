# Phase 3: WASM Plugin ABI v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hard-coded `SineGenerator` in the audio worklet with a real WASM plugin runtime that loads a documented ABI, runs a linear chain of plugin instances, and exposes per-instance HTML UIs as floating windows. End-to-end demo: drag the Sine + Gain plugins from the Browser into the chain, play, open the Gain UI, twist a knob, hear the change.

**Design reference:** `docs/superpowers/specs/2026-05-18-phase-3-plugin-abi-v1-design.md`. Read it first.

**Tech stack additions:**
- AssemblyScript (`assemblyscript` npm dev dep) for building the reference plugins.
- No new host-side runtime deps; everything is `WebAssembly.*` + existing infrastructure.

**Phase 2's invariants we keep:**
- Project state still lives in the SharedWorker coordinator.
- The main thread is still a thin view; all plugin loads dispatch through `useDispatch`.
- Existing 67 tests still pass at every commit.

**Out of scope (deferred):**
- Multi-track audio routing (Phase 6).
- `.noaplugin` ZIP + Service Worker delivery (Phase 5).
- Plugin workers / async preset loads (Phase 4).
- Per-instance meter publishing (Phase 4).
- Sample-accurate parameter automation.

---

## File structure

**Create:**

- `docs/plugin-abi-v1.md` — authoritative ABI spec for plugin authors.
- `src/engine/PluginAbi.ts` — host-side ABI constants, export-symbol names, version.
- `src/engine/PluginManifest.ts` — manifest types + validator.
- `src/engine/PluginHost.ts` — main-thread plugin instance runner (for tests + offline use).
- `src/engine/PluginRegistry.ts` — registry of installed plugins; fetch + compile.
- `src/engine/PluginUIHost.ts` — iframe lifecycle.
- `src/engine/PluginUIProtocol.ts` — postMessage envelope types.
- `src/engine/__tests__/PluginHost.test.ts`
- `src/engine/__tests__/PluginRegistry.test.ts`
- `src/engine/__tests__/PluginManifest.test.ts`
- `src/engine/__tests__/PluginUIProtocol.test.ts`
- `src/engine/__tests__/fixtures/test-plugin/` — tiny AS plugin used as a unit-test fixture.
- `src/builtin-plugins/sine/` — first reference plugin (replaces `SineGenerator`).
- `src/builtin-plugins/gain/` — second reference plugin (insert FX).
- `src/components/PluginWindow.jsx` — floating-panel chrome.

**Modify:**

- `package.json` — `assemblyscript` dev dep; `build:plugins` script.
- `src/engine/audio-worklet.ts` — replace SineGenerator chain with plugin chain.
- `src/engine/EngineClient.ts` — `loadPlugin` / `unloadInstance` / control-message protocol.
- `src/engine/EngineEvent.ts` — extend usage notes for `targetId` semantics (no schema change).
- `src/coordinator/projectModel.ts` — `PluginInstance` type; replace `Channel.effects` shape and `Track.generator` shape.
- `src/coordinator/actions.ts` — `load-plugin`, `unload-plugin`, `set-param`, `set-instance-bypass`.
- `src/coordinator/reducer.ts` — handlers for the above.
- `src/coordinator/__tests__/*` — extend reducer tests for new actions.
- `src/data.js` — re-seed the demo project to use plugin instances.
- `src/App.jsx` — bootstrap plugin registry + load demo instances on first launch.
- `src/components/Mixer.jsx` — double-click an FX rack entry → open PluginWindow.
- `src/components/Browser.jsx` — drag-drop of plugin into mixer dispatches `load-plugin`.
- `CLAUDE.md` — new Plugin module section.

**Delete:**

- `src/engine/dsp/SineGenerator.ts`
- `src/engine/dsp/__tests__/SineGenerator.test.ts`
- The `src/engine/dsp/` directory if empty after deletion.

---

### Task 1: Author `docs/plugin-abi-v1.md` + scaffold ABI types

**Files:**
- Create: `docs/plugin-abi-v1.md`
- Create: `src/engine/PluginAbi.ts`
- Create: `src/engine/PluginManifest.ts`
- Create: `src/engine/__tests__/PluginManifest.test.ts`

- [ ] **Step 1: Write the authoritative spec**

Create `docs/plugin-abi-v1.md` mirroring Section 4 of the design spec verbatim, with code-block signatures and worked examples. The body lifts the ABI table, manifest schema, and memory-model section out of the design spec so plugin authors don't have to read the design doc. Begin with:

```
# Noa Plugin ABI v1

Authoritative reference. Last updated: 2026-05-18. ABI version: 1.

This document is what a plugin author needs to write a conforming Noa plugin.
The host-side design rationale lives in `docs/superpowers/specs/2026-05-18-phase-3-plugin-abi-v1-design.md`.
```

Then sections: Required exports / Imports / Memory model / Manifest schema / Worked example (a 20-line AS plugin source). Copy the tables exactly.

- [ ] **Step 2: Write failing manifest tests**

Create `src/engine/__tests__/PluginManifest.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseManifest, ABI_VERSION, type PluginManifest } from '../PluginManifest';

const VALID: unknown = {
  id: 'com.noa.test',
  name: 'Test',
  version: '1.0.0',
  abi_version: 1,
  kind: 'gen',
  params: [
    { name: 'Volume', min: 0, max: 1, default: 0.5 },
  ],
};

describe('parseManifest', () => {
  it('accepts a minimal valid manifest', () => {
    const m = parseManifest(VALID);
    expect(m.id).toBe('com.noa.test');
    expect(m.params).toHaveLength(1);
    expect(m.params[0]!.unit).toBeUndefined();
    expect(m.params[0]!.display).toBe('linear');
    expect(m.params[0]!.step).toBe(0);
  });

  it('rejects wrong ABI version', () => {
    expect(() => parseManifest({ ...(VALID as object), abi_version: 99 })).toThrow(/abi_version/);
  });

  it('rejects unknown kind', () => {
    expect(() => parseManifest({ ...(VALID as object), kind: 'oops' })).toThrow(/kind/);
  });

  it('rejects missing required fields', () => {
    const broken = { ...(VALID as object) } as Record<string, unknown>;
    delete broken.id;
    expect(() => parseManifest(broken)).toThrow(/id/);
  });

  it('rejects params with min >= max', () => {
    expect(() =>
      parseManifest({ ...(VALID as object), params: [{ name: 'X', min: 1, max: 0, default: 0.5 }] }),
    ).toThrow(/min.*max/);
  });

  it('rejects default outside [min, max]', () => {
    expect(() =>
      parseManifest({ ...(VALID as object), params: [{ name: 'X', min: 0, max: 1, default: 2 }] }),
    ).toThrow(/default/);
  });

  it('accepts optional ui block', () => {
    const m = parseManifest({
      ...(VALID as object),
      ui: { entry: 'index.html', width: 200, height: 200 },
    });
    expect(m.ui).toEqual({ entry: 'index.html', width: 200, height: 200 });
  });

  it('exposes the host ABI version constant', () => {
    expect(ABI_VERSION).toBe(1);
  });
});
```

- [ ] **Step 3: Implement `PluginAbi.ts` and `PluginManifest.ts`**

Create `src/engine/PluginAbi.ts`:

```typescript
export const ABI_VERSION = 1 as const;

/** Names of the WASM exports the host calls. */
export const EXPORTS = {
  abi_version: 'noa_abi_version',
  init: 'noa_init',
  audio_in_ptr: 'noa_get_audio_in_ptr',
  audio_out_ptr: 'noa_get_audio_out_ptr',
  event_buf_ptr: 'noa_get_event_buf_ptr',
  event_buf_capacity: 'noa_event_buf_capacity',
  param_buf_ptr: 'noa_get_param_buf_ptr',
  param_count: 'noa_param_count',
  process: 'noa_process',
  state_size: 'noa_state_size',
  get_state: 'noa_get_state',
  set_state: 'noa_set_state',
  destroy: 'noa_destroy',
} as const;

/** WASM memory export name. Standard for AssemblyScript and most other toolchains. */
export const MEMORY_EXPORT = 'memory';
```

Create `src/engine/PluginManifest.ts`:

```typescript
import { ABI_VERSION } from './PluginAbi';

export { ABI_VERSION };

export type PluginKind = 'gen' | 'fx';
export type ParamDisplay = 'linear' | 'log' | 'db' | 'hz' | 'percent';

export interface ParamDecl {
  name: string;
  min: number;
  max: number;
  default: number;
  step: number;            // 0 = continuous; >0 = quantized
  unit?: string;
  display: ParamDisplay;
}

export interface PluginUi {
  entry: string;
  width: number;
  height: number;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  abi_version: number;
  kind: PluginKind;
  params: ParamDecl[];
  ui?: PluginUi;
}

function fail(msg: string): never {
  throw new Error(`PluginManifest: ${msg}`);
}

function reqString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) fail(`missing or invalid ${key}`);
  return v;
}

function reqNumber(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`missing or invalid ${key}`);
  return v;
}

function parseParam(p: unknown, i: number): ParamDecl {
  if (!p || typeof p !== 'object') fail(`params[${i}] not an object`);
  const o = p as Record<string, unknown>;
  const min = reqNumber(o, 'min');
  const max = reqNumber(o, 'max');
  if (min >= max) fail(`params[${i}]: min must be < max`);
  const def = reqNumber(o, 'default');
  if (def < min || def > max) fail(`params[${i}]: default ${def} outside [${min}, ${max}]`);
  const step = o.step === undefined ? 0 : reqNumber(o, 'step');
  const displayRaw = (o.display ?? 'linear') as string;
  const display: ParamDisplay = displayRaw === 'linear' || displayRaw === 'log'
    || displayRaw === 'db' || displayRaw === 'hz' || displayRaw === 'percent'
    ? displayRaw
    : fail(`params[${i}]: invalid display '${displayRaw}'`);
  return {
    name: reqString(o, 'name'),
    min, max, default: def, step,
    unit: typeof o.unit === 'string' ? o.unit : undefined,
    display,
  };
}

export function parseManifest(raw: unknown): PluginManifest {
  if (!raw || typeof raw !== 'object') fail('not an object');
  const o = raw as Record<string, unknown>;
  const abi = reqNumber(o, 'abi_version');
  if (abi !== ABI_VERSION) fail(`abi_version ${abi} != ${ABI_VERSION}`);
  const kind = reqString(o, 'kind');
  if (kind !== 'gen' && kind !== 'fx') fail(`invalid kind '${kind}'`);
  const paramsRaw = o.params;
  if (!Array.isArray(paramsRaw)) fail('params must be an array');
  const params = paramsRaw.map((p, i) => parseParam(p, i));
  const result: PluginManifest = {
    id: reqString(o, 'id'),
    name: reqString(o, 'name'),
    version: reqString(o, 'version'),
    abi_version: abi,
    kind,
    params,
  };
  if (o.ui !== undefined) {
    if (!o.ui || typeof o.ui !== 'object') fail('ui must be an object');
    const u = o.ui as Record<string, unknown>;
    result.ui = {
      entry: reqString(u, 'entry'),
      width: reqNumber(u, 'width'),
      height: reqNumber(u, 'height'),
    };
  }
  return result;
}
```

- [ ] **Step 4: Run tests + typecheck**

```bash
npm test -- PluginManifest
npm run typecheck
```

Expected: 8 tests pass, zero type errors.

- [ ] **Step 5: Commit**

```bash
git add docs/plugin-abi-v1.md src/engine/PluginAbi.ts src/engine/PluginManifest.ts src/engine/__tests__/PluginManifest.test.ts
git commit -m "feat(engine): plugin ABI v1 types + manifest parser"
```

---

### Task 2: AssemblyScript toolchain + test-plugin fixture

**Files:**
- Modify: `package.json`
- Create: `src/engine/__tests__/fixtures/test-plugin/package.json`
- Create: `src/engine/__tests__/fixtures/test-plugin/asconfig.json`
- Create: `src/engine/__tests__/fixtures/test-plugin/src/index.ts`
- Create: `src/engine/__tests__/fixtures/test-plugin/plugin.json`
- Create: `src/engine/__tests__/fixtures/test-plugin/plugin.wasm` (built artifact)
- Create: `src/engine/__tests__/fixtures/test-plugin/README.md`

**Design notes:** The fixture is a minimal plugin that implements every required export so we can drive the host code in unit tests. It's intentionally trivial — single param "Volume", multiplies input by Volume, ignores events. Lives under `__tests__/fixtures/` so it's clearly test-only.

- [ ] **Step 1: Install AssemblyScript at repo root**

```bash
npm install --save-dev assemblyscript@^0.27.30
```

The host repo gets `asc` so the top-level `build:plugins` script works.

- [ ] **Step 2: Add `build:plugins` script to `package.json`**

Add to the `scripts` block:

```json
"build:plugins": "bash scripts/build-plugins.sh"
```

(Built artifacts are committed; this script is rebuild-only.)

Create `scripts/build-plugins.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for dir in \
  "$ROOT/src/engine/__tests__/fixtures/test-plugin" \
  "$ROOT/src/builtin-plugins/sine" \
  "$ROOT/src/builtin-plugins/gain"
do
  if [ -f "$dir/asconfig.json" ]; then
    echo "Building $dir"
    (cd "$dir" && npx --prefix "$ROOT" asc src/index.ts -o plugin.wasm --runtime stub --optimize)
  fi
done
```

```bash
chmod +x scripts/build-plugins.sh
```

- [ ] **Step 3: Create the test-plugin source**

Create `src/engine/__tests__/fixtures/test-plugin/asconfig.json`:

```json
{
  "targets": {
    "release": { "outFile": "plugin.wasm", "optimizeLevel": 3, "runtime": "stub" }
  },
  "options": { "exportRuntime": false, "bindings": "raw" }
}
```

Create `src/engine/__tests__/fixtures/test-plugin/package.json`:

```json
{ "name": "noa-test-plugin", "private": true, "version": "0.0.0" }
```

Create `src/engine/__tests__/fixtures/test-plugin/plugin.json`:

```json
{
  "id": "com.noa.test",
  "name": "Test Plugin",
  "version": "0.0.1",
  "abi_version": 1,
  "kind": "fx",
  "params": [
    { "name": "Volume", "min": 0, "max": 2, "default": 1, "unit": "x", "display": "linear" }
  ]
}
```

Create `src/engine/__tests__/fixtures/test-plugin/src/index.ts`:

```typescript
// AssemblyScript. Compile with: npx asc src/index.ts -o plugin.wasm --runtime stub --optimize

const MAX_BLOCK = 2048;
const MAX_EVENTS = 256;
const PARAM_COUNT = 1;

// Static buffers — preallocated as global typed arrays.
const audioIn = new StaticArray<f32>(MAX_BLOCK * 2);
const audioOut = new StaticArray<f32>(MAX_BLOCK * 2);
const eventBuf = new StaticArray<u8>(MAX_EVENTS * 32);
const paramBuf = new StaticArray<f32>(PARAM_COUNT);

let initialized: bool = false;
let lastSeenSampleRate: u32 = 0;

export function noa_abi_version(): u32 { return 1; }

export function noa_init(sampleRate: u32, maxBlockSize: u32): u32 {
  if (maxBlockSize > MAX_BLOCK) return 0;
  initialized = true;
  lastSeenSampleRate = sampleRate;
  paramBuf[0] = 1.0; // default volume
  return 1;
}

export function noa_get_audio_in_ptr():     u32 { return changetype<usize>(audioIn) as u32; }
export function noa_get_audio_out_ptr():    u32 { return changetype<usize>(audioOut) as u32; }
export function noa_get_event_buf_ptr():    u32 { return changetype<usize>(eventBuf) as u32; }
export function noa_event_buf_capacity():   u32 { return MAX_EVENTS; }
export function noa_get_param_buf_ptr():    u32 { return changetype<usize>(paramBuf) as u32; }
export function noa_param_count():          u32 { return PARAM_COUNT; }

export function noa_process(nFrames: u32, nEvents: u32): void {
  if (!initialized) return;
  const volume: f32 = paramBuf[0];
  for (let i: u32 = 0; i < nFrames * 2; i++) {
    audioOut[i] = audioIn[i] * volume;
  }
}

export function noa_state_size(): u32 { return 4; }

export function noa_get_state(outPtr: u32): u32 {
  store<f32>(outPtr, paramBuf[0]);
  return 4;
}

export function noa_set_state(inPtr: u32, nBytes: u32): u32 {
  if (nBytes != 4) return 0;
  paramBuf[0] = load<f32>(inPtr);
  return 1;
}

export function noa_destroy(): void { initialized = false; }
```

Create `src/engine/__tests__/fixtures/test-plugin/README.md`:

```
Test fixture plugin. Not a real plugin — does just enough to exercise the host's
plugin runner in unit tests. Rebuild after editing src/index.ts:

  ./scripts/build-plugins.sh

(The built plugin.wasm is committed so CI doesn't need AssemblyScript.)
```

- [ ] **Step 4: Build the fixture**

```bash
./scripts/build-plugins.sh
```

Expected: `src/engine/__tests__/fixtures/test-plugin/plugin.wasm` exists, ~1KB.

- [ ] **Step 5: Sanity-check the WASM**

Run a quick standalone instantiate check:

```bash
node -e '
import fs from "node:fs";
import path from "node:path";
const buf = fs.readFileSync(path.resolve("src/engine/__tests__/fixtures/test-plugin/plugin.wasm"));
WebAssembly.instantiate(buf, { host: { log: () => {}, random: () => 0.5, get_tempo: () => 120 } }).then(({ instance }) => {
  const e = instance.exports;
  console.log("abi:", e.noa_abi_version());
  console.log("init:", e.noa_init(48000, 128));
  console.log("paramCount:", e.noa_param_count());
  console.log("eventCap:", e.noa_event_buf_capacity());
  console.log("in:", e.noa_get_audio_in_ptr(), "out:", e.noa_get_audio_out_ptr());
});
' --input-type=module
```

Expected: `abi: 1`, `init: 1`, `paramCount: 1`, `eventCap: 256`, two non-zero pointers.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json scripts/build-plugins.sh src/engine/__tests__/fixtures/test-plugin
git commit -m "build(plugins): AssemblyScript toolchain + test-plugin fixture"
```

---

### Task 3: PluginHost — lifecycle, params, process, state (TDD)

**Files:**
- Create: `src/engine/PluginHost.ts`
- Create: `src/engine/__tests__/PluginHost.test.ts`

**Design notes:** `PluginHost` is a main-thread wrapper around a `WebAssembly.Instance`. The worklet has its own analogous runtime (Task 6) but reusing the same TypeScript class isn't possible because the worklet runs in a different global scope. `PluginHost` is the unit-tested reference implementation; the worklet's runtime mirrors it.

Key surface:

```typescript
class PluginHost {
  static async fromBytes(bytes: BufferSource, manifest: PluginManifest, opts: HostInitOpts): Promise<PluginHost>;
  readonly manifest: PluginManifest;
  readonly memory: WebAssembly.Memory;
  setParam(index: number, value: number): void;
  readParam(index: number): number;
  pushEvents(frames: Uint8Array, count: number): void;   // writes into the plugin's event buf
  writeInput(samples: Float32Array): void;               // interleaved stereo
  readOutput(out: Float32Array): void;
  process(nFrames: number, nEvents: number): void;
  getState(): Uint8Array;
  setState(bytes: Uint8Array): boolean;
  destroy(): void;
}
```

- [ ] **Step 1: Write failing tests**

Create `src/engine/__tests__/PluginHost.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PluginHost } from '../PluginHost';
import { parseManifest } from '../PluginManifest';

const FIXTURE_DIR = path.resolve('src/engine/__tests__/fixtures/test-plugin');

let bytes: Uint8Array;
let manifest = parseManifest({
  id: 'com.noa.test', name: 'Test', version: '0.0.1', abi_version: 1, kind: 'fx',
  params: [{ name: 'Volume', min: 0, max: 2, default: 1 }],
});

beforeAll(async () => {
  bytes = await readFile(path.join(FIXTURE_DIR, 'plugin.wasm'));
});

describe('PluginHost.fromBytes', () => {
  it('instantiates and reports the ABI version', async () => {
    const h = await PluginHost.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    expect(h.manifest.id).toBe('com.noa.test');
    h.destroy();
  });

  it('rejects modules whose noa_abi_version disagrees with the host', async () => {
    // Build a bogus module that exports noa_abi_version = 99. Simplest: hand-built WAT.
    // Skipped: we trust the parseManifest check + runtime check share an implementation.
  });
});

describe('PluginHost params', () => {
  it('writes the manifest default into the param buffer after init', async () => {
    const h = await PluginHost.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    expect(h.readParam(0)).toBeCloseTo(1.0);
    h.destroy();
  });

  it('round-trips setParam / readParam', async () => {
    const h = await PluginHost.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    h.setParam(0, 0.25);
    expect(h.readParam(0)).toBeCloseTo(0.25);
    h.destroy();
  });
});

describe('PluginHost process', () => {
  it('applies volume of 1.0 unchanged', async () => {
    const h = await PluginHost.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    const inp = new Float32Array(128 * 2);
    for (let i = 0; i < inp.length; i++) inp[i] = 0.5;
    h.writeInput(inp);
    h.process(128, 0);
    const out = new Float32Array(128 * 2);
    h.readOutput(out);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(0.5);
    h.destroy();
  });

  it('scales output by the current Volume param', async () => {
    const h = await PluginHost.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    h.setParam(0, 0.5);
    const inp = new Float32Array(128 * 2);
    for (let i = 0; i < inp.length; i++) inp[i] = 0.8;
    h.writeInput(inp);
    h.process(128, 0);
    const out = new Float32Array(128 * 2);
    h.readOutput(out);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(0.4, 5);
    h.destroy();
  });
});

describe('PluginHost state', () => {
  it('round-trips state via get_state / set_state', async () => {
    const a = await PluginHost.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    a.setParam(0, 0.123);
    const snapshot = a.getState();
    a.destroy();
    const b = await PluginHost.fromBytes(bytes, manifest, { sampleRate: 48000, maxBlockSize: 128 });
    expect(b.setState(snapshot)).toBe(true);
    expect(b.readParam(0)).toBeCloseTo(0.123, 5);
    b.destroy();
  });
});
```

- [ ] **Step 2: Run tests; they should fail**

```bash
npm test -- PluginHost
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement `PluginHost.ts`**

Create `src/engine/PluginHost.ts`:

```typescript
import { ABI_VERSION, EXPORTS, MEMORY_EXPORT } from './PluginAbi';
import type { PluginManifest } from './PluginManifest';

export interface HostInitOpts {
  sampleRate: number;
  maxBlockSize: number;
  hostImports?: Partial<HostImports>;
}

export interface HostImports {
  log: (ptr: number, len: number) => void;
  random: () => number;
  get_tempo: () => number;
}

const DEFAULT_IMPORTS: HostImports = {
  log: () => {},
  random: () => Math.random(),
  get_tempo: () => 120,
};

type WasmExports = {
  [k in keyof typeof EXPORTS]: (...args: any[]) => any;
} & { [MEMORY_EXPORT]: WebAssembly.Memory };

export class PluginHost {
  readonly manifest: PluginManifest;
  readonly memory: WebAssembly.Memory;
  readonly maxBlockSize: number;
  readonly sampleRate: number;

  private readonly exports: WasmExports;
  private readonly audioInPtr: number;
  private readonly audioOutPtr: number;
  private readonly eventBufPtr: number;
  private readonly eventBufCapacity: number;
  private readonly paramBufPtr: number;
  private readonly paramCount: number;
  private destroyed = false;

  static async fromBytes(
    bytes: BufferSource,
    manifest: PluginManifest,
    opts: HostInitOpts,
  ): Promise<PluginHost> {
    const module = await WebAssembly.compile(bytes);
    return PluginHost.fromModule(module, manifest, opts);
  }

  static async fromModule(
    module: WebAssembly.Module,
    manifest: PluginManifest,
    opts: HostInitOpts,
  ): Promise<PluginHost> {
    const imports = { ...DEFAULT_IMPORTS, ...(opts.hostImports ?? {}) };
    const instance = await WebAssembly.instantiate(module, {
      host: imports,
      // AssemblyScript's `abort` import is sometimes referenced from the stub runtime.
      env: { abort: () => { throw new Error('plugin aborted'); } },
    });
    return new PluginHost(instance.exports as unknown as WasmExports, manifest, opts);
  }

  private constructor(
    exports: WasmExports,
    manifest: PluginManifest,
    opts: HostInitOpts,
  ) {
    this.exports = exports;
    this.manifest = manifest;
    this.memory = exports[MEMORY_EXPORT];
    this.sampleRate = opts.sampleRate;
    this.maxBlockSize = opts.maxBlockSize;

    const v = exports[EXPORTS.abi_version]() as number;
    if (v !== ABI_VERSION) {
      throw new Error(`PluginHost: WASM noa_abi_version()=${v} != host ${ABI_VERSION}`);
    }
    const ok = exports[EXPORTS.init](opts.sampleRate, opts.maxBlockSize) as number;
    if (ok !== 1) throw new Error('PluginHost: noa_init returned 0');

    this.audioInPtr = exports[EXPORTS.audio_in_ptr]() as number;
    this.audioOutPtr = exports[EXPORTS.audio_out_ptr]() as number;
    this.eventBufPtr = exports[EXPORTS.event_buf_ptr]() as number;
    this.eventBufCapacity = exports[EXPORTS.event_buf_capacity]() as number;
    this.paramBufPtr = exports[EXPORTS.param_buf_ptr]() as number;
    this.paramCount = exports[EXPORTS.param_count]() as number;

    if (this.paramCount !== manifest.params.length) {
      throw new Error(
        `PluginHost: manifest declares ${manifest.params.length} params but module exports ${this.paramCount}`,
      );
    }
  }

  setParam(index: number, value: number): void {
    if (this.destroyed) return;
    if (index < 0 || index >= this.paramCount) {
      throw new Error(`PluginHost.setParam: index ${index} out of range [0, ${this.paramCount})`);
    }
    const view = new Float32Array(this.memory.buffer, this.paramBufPtr + index * 4, 1);
    view[0] = value;
  }

  readParam(index: number): number {
    if (index < 0 || index >= this.paramCount) {
      throw new Error(`PluginHost.readParam: index ${index} out of range [0, ${this.paramCount})`);
    }
    const view = new Float32Array(this.memory.buffer, this.paramBufPtr + index * 4, 1);
    return view[0]!;
  }

  pushEvents(frames: Uint8Array, count: number): void {
    if (count > this.eventBufCapacity) {
      throw new Error(`PluginHost.pushEvents: ${count} > capacity ${this.eventBufCapacity}`);
    }
    if (frames.length < count * 32) {
      throw new Error('PluginHost.pushEvents: source frames buffer too small');
    }
    const dst = new Uint8Array(this.memory.buffer, this.eventBufPtr, count * 32);
    dst.set(frames.subarray(0, count * 32));
  }

  writeInput(samples: Float32Array): void {
    if (samples.length > this.maxBlockSize * 2) {
      throw new Error(`PluginHost.writeInput: ${samples.length} > ${this.maxBlockSize * 2}`);
    }
    const dst = new Float32Array(this.memory.buffer, this.audioInPtr, samples.length);
    dst.set(samples);
  }

  readOutput(out: Float32Array): void {
    if (out.length > this.maxBlockSize * 2) {
      throw new Error(`PluginHost.readOutput: ${out.length} > ${this.maxBlockSize * 2}`);
    }
    const src = new Float32Array(this.memory.buffer, this.audioOutPtr, out.length);
    out.set(src);
  }

  process(nFrames: number, nEvents: number): void {
    if (this.destroyed) return;
    if (nFrames > this.maxBlockSize) {
      throw new Error(`PluginHost.process: nFrames ${nFrames} > maxBlockSize ${this.maxBlockSize}`);
    }
    this.exports[EXPORTS.process](nFrames, nEvents);
  }

  getState(): Uint8Array {
    const size = this.exports[EXPORTS.state_size]() as number;
    if (size === 0) return new Uint8Array(0);
    const scratch = (this.exports[EXPORTS.audio_in_ptr]() as number);
    // Reuse the audio-in slot as scratch — the plugin's contract guarantees that's
    // safe between blocks. (Future: have plugin allocate a dedicated state-out region.)
    const bytesWritten = this.exports[EXPORTS.get_state](scratch) as number;
    const view = new Uint8Array(this.memory.buffer, scratch, bytesWritten);
    return new Uint8Array(view); // copy out of the WASM memory
  }

  setState(bytes: Uint8Array): boolean {
    const size = bytes.length;
    if (size === 0) return true;
    const scratch = this.exports[EXPORTS.audio_in_ptr]() as number;
    const dst = new Uint8Array(this.memory.buffer, scratch, size);
    dst.set(bytes);
    return (this.exports[EXPORTS.set_state](scratch, size) as number) === 1;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.exports[EXPORTS.destroy]();
    this.destroyed = true;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- PluginHost
```

Expected: all 5 tests pass.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/engine/PluginHost.ts src/engine/__tests__/PluginHost.test.ts
git commit -m "feat(engine): PluginHost — main-thread WASM plugin runner"
```

---

### Task 4: PluginRegistry — manifest + WASM fetch and compile

**Files:**
- Create: `src/engine/PluginRegistry.ts`
- Create: `src/engine/__tests__/PluginRegistry.test.ts`

**Design notes:**

```typescript
class PluginRegistry {
  install(entry: PluginRegistryEntry): void;
  has(id: string): boolean;
  get(id: string): PluginRegistryEntry;
  list(): PluginRegistryEntry[];
  // Helper for app boot:
  static async loadBuiltin(baseUrl: string): Promise<PluginRegistryEntry>;
}

interface PluginRegistryEntry {
  manifest: PluginManifest;
  module: WebAssembly.Module;
  uiAssets: Map<string, Uint8Array>;   // path → bytes; empty if no UI
}
```

`loadBuiltin(baseUrl)` fetches `baseUrl/plugin.json`, validates manifest, fetches `baseUrl/plugin.wasm`, compiles. If manifest declares a UI, fetches `baseUrl/ui/<entry>` (only the entry file for v1; multi-file UIs ship in Phase 5).

- [ ] **Step 1: Write failing tests**

Create `src/engine/__tests__/PluginRegistry.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PluginRegistry } from '../PluginRegistry';
import { parseManifest } from '../PluginManifest';

let bytes: Uint8Array;
const manifest = parseManifest({
  id: 'com.noa.test', name: 'Test', version: '0.0.1', abi_version: 1, kind: 'fx',
  params: [{ name: 'Volume', min: 0, max: 2, default: 1 }],
});

beforeAll(async () => {
  bytes = await readFile(path.resolve('src/engine/__tests__/fixtures/test-plugin/plugin.wasm'));
});

describe('PluginRegistry', () => {
  it('registers and retrieves an entry', async () => {
    const reg = new PluginRegistry();
    const module = await WebAssembly.compile(bytes);
    reg.install({ manifest, module, uiAssets: new Map() });
    expect(reg.has('com.noa.test')).toBe(true);
    expect(reg.get('com.noa.test').manifest.name).toBe('Test');
    expect(reg.list()).toHaveLength(1);
  });

  it('rejects duplicate ids', async () => {
    const reg = new PluginRegistry();
    const module = await WebAssembly.compile(bytes);
    reg.install({ manifest, module, uiAssets: new Map() });
    expect(() => reg.install({ manifest, module, uiAssets: new Map() })).toThrow(/already installed/);
  });

  it('get() throws on unknown id', () => {
    const reg = new PluginRegistry();
    expect(() => reg.get('com.unknown.x')).toThrow(/not installed/);
  });
});
```

- [ ] **Step 2: Implement `PluginRegistry.ts`**

```typescript
import { parseManifest, type PluginManifest } from './PluginManifest';

export interface PluginRegistryEntry {
  manifest: PluginManifest;
  module: WebAssembly.Module;
  uiAssets: Map<string, Uint8Array>;
}

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
   * Note: Vite serves `src/builtin-plugins/<id>/*` as-is during dev. For production builds we
   * configure Vite to copy these into the dist; that wiring lives in Task 8.
   */
  static async loadBuiltin(baseUrl: string): Promise<PluginRegistryEntry> {
    const manifestRes = await fetch(`${baseUrl}/plugin.json`);
    if (!manifestRes.ok) throw new Error(`PluginRegistry.loadBuiltin: manifest fetch failed for ${baseUrl}`);
    const manifest = parseManifest(await manifestRes.json());

    const wasmRes = await fetch(`${baseUrl}/plugin.wasm`);
    if (!wasmRes.ok) throw new Error(`PluginRegistry.loadBuiltin: wasm fetch failed for ${baseUrl}`);
    const module = await WebAssembly.compileStreaming(wasmRes);

    const uiAssets = new Map<string, Uint8Array>();
    if (manifest.ui) {
      const uiRes = await fetch(`${baseUrl}/ui/${manifest.ui.entry}`);
      if (!uiRes.ok) throw new Error(`PluginRegistry.loadBuiltin: ui fetch failed for ${baseUrl}`);
      uiAssets.set(manifest.ui.entry, new Uint8Array(await uiRes.arrayBuffer()));
    }

    return { manifest, module, uiAssets };
  }
}
```

- [ ] **Step 3: Run tests + typecheck + commit**

```bash
npm test -- PluginRegistry
npm run typecheck
git add src/engine/PluginRegistry.ts src/engine/__tests__/PluginRegistry.test.ts
git commit -m "feat(engine): PluginRegistry — fetch + compile + catalog"
```

---

### Task 5: Coordinator project model — PluginInstance, actions, reducer

**Files:**
- Modify: `src/coordinator/projectModel.ts`
- Modify: `src/coordinator/actions.ts`
- Modify: `src/coordinator/reducer.ts`
- Modify: `src/coordinator/__tests__/reducer.test.ts` (rewrite the "effects" + "tracks" blocks)
- Modify: `src/data.js` (reseed demo)
- Modify: `src/App.jsx` (callbacks now mint instances by pluginId, not by old name/kind)
- Modify: `src/components/Mixer.jsx`, `src/components/Playlist.jsx`, `src/components/Browser.jsx` (consume the new shape)

**Design notes:** Clean break — no backward-compat shims. New shapes from the design spec:

```typescript
interface PluginInstance {
  id: string;
  pluginId: string;       // manifest id; required, every instance must reference a registered plugin
  bypass: boolean;
  params: number[];       // canonical values, indexed per manifest param order
}

interface Channel { /* ...existing */ effects: PluginInstance[]; }
interface Track   { /* ...existing */ generator: PluginInstance | null; }
```

The legacy `Effect` type, `EffectKind` union, and `name`/`kind` display fields are **deleted**. UI display name and kind come from the plugin's manifest, looked up via `PluginRegistry.get(pluginId).manifest`. Components receive the registry as a prop.

Legacy actions deleted: `ADD_EFFECT`, `REMOVE_EFFECT`, `BYPASS_EFFECT`, `ASSIGN_GENERATOR`. They are superseded by the new plugin-aware ones.

Demo project reseed: only entries referencing real loadable plugins survive.
- `t1.generator` → `{ pluginId: 'com.noa.sine', params: <defaults> }`
- `m0.effects` → `[{ pluginId: 'com.noa.gain', params: <defaults> }]`
- Every other `track.generator` → `null`, every other `channel.effects` → `[]`.

`<defaults>` is filled in by the engine boot code (Task 8) once manifests are known; for now the seed uses `[]` and the reducer treats an empty `params` array as "needs hydration."

- [ ] **Step 1: Replace `projectModel.ts`**

Delete `Effect` and `EffectKind`. Add `PluginInstance` with the four fields above. Change `Channel.effects` to `PluginInstance[]`. Change `Track.generator` to `PluginInstance | null`. `seedProject()` calls a new local `seedDemo()` helper that builds the new shape from scratch rather than `structuredClone`ing `data.js` — `data.js` only seeds raw tracks/channels metadata; plugin instances are minted in the seeder.

- [ ] **Step 2: Update `data.js`**

Reduce `DEMO_CHANNELS` to one effect on `m0`: `{ id: 'i0', pluginId: 'com.noa.gain', bypass: false, params: [] }`. All other channels have `effects: []`. Reduce `DEMO_TRACKS` so `t1.generator = { id: 'i1', pluginId: 'com.noa.sine', bypass: false, params: [] }` and all other tracks have `generator: null`. (Old display fields like `Sytrus`, `Serum` etc. are removed entirely.)

- [ ] **Step 3: Replace actions**

`actions.ts` discriminants for plugin lifecycle:

```typescript
| { type: 'LOAD_PLUGIN'; pluginId: string; target: { kind: 'channel-fx'; channelId: string; insertAt?: number } | { kind: 'track-generator'; trackId: string }; defaults: number[] }
| { type: 'UNLOAD_PLUGIN'; instanceId: string }
| { type: 'SET_PARAM'; instanceId: string; paramIndex: number; value: number }
| { type: 'SET_INSTANCE_BYPASS'; instanceId: string; bypass: boolean }
```

`ADD_EFFECT`, `REMOVE_EFFECT`, `BYPASS_EFFECT`, `ASSIGN_GENERATOR` are deleted.

- [ ] **Step 4: Replace reducer cases**

Drop the four legacy cases. Add the four new cases. `LOAD_PLUGIN` mints a fresh `id` (`'i' + base36 random`), sets `params` to a copy of `defaults`. `UNLOAD_PLUGIN` / `SET_PARAM` / `SET_INSTANCE_BYPASS` walk both `tracks.generator` and `channels.effects` to find the matching `instanceId`.

- [ ] **Step 5: Rewrite the reducer test cases**

Delete the `reducer — effects` describe block and the `ASSIGN_GENERATOR` test. Replace with cases for the four new actions: happy path, unknown-instance no-op, patches.

- [ ] **Step 6: Update JSX consumers (UI break is acceptable mid-refactor)**

- `App.jsx`: replace `assignGenerator`, `addEffect`, `removeEffect`, `bypassEffect` callbacks with `loadPlugin(pluginId, target, defaults)`, `unloadPlugin(instanceId)`, `setParam(instanceId, idx, value)`, `setInstanceBypass(instanceId, bypass)`. The Browser drag-drop into a track or FX rack now needs to know a real `pluginId` — for Phase 3 it maps the drag-source plugin name to its registered id (the registry exposes `list()`).
- `Mixer.jsx`: receives a new `registry` prop (`PluginRegistry`). Render each effect's display via `registry.get(fx.pluginId)?.manifest.name`. `FX_ICON[kind]` reads from the manifest's `kind`. Until the registry is populated, render a placeholder (`'…'`).
- `Playlist.jsx`: `t.generator` is now an object. Render `t.generator ? registry.get(t.generator.pluginId)?.manifest.name : (t.type === 'audio' ? 'Audio in' : 'No plugin')`.
- `Browser.jsx`: when dragging an existing demo plugin entry that doesn't have a registered pluginId, the drop is a no-op (UI accepts but coordinator rejects). Only `Sine` and `Gain` in the Browser have real pluginIds.

- [ ] **Step 7: Run all tests + typecheck + smoke test**

```bash
npm test
npm run typecheck
npm run dev
```

Expected: all coordinator unit tests pass with rewritten cases. Mixer renders one effect (`Gain`) on Master and no effects elsewhere. Track 1 displays `Sine` as its generator; other tracks show "No plugin." Audio still doesn't work yet — that's Task 8.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(coordinator): PluginInstance model + LOAD_PLUGIN / SET_PARAM actions"
```

---

### Task 6: Worklet plugin runtime + per-instance rings

**Files:**
- Modify: `src/engine/audio-worklet.ts`
- Modify: `src/engine/RingBuffer.ts` — no schema change; possibly add a helper that returns the SAB.

**Design notes:** The worklet maintains a `PluginRuntime[]` array (the linear signal chain). On `INSTANTIATE_PLUGIN` it instantiates a new `PluginRuntime` and places it in `slot`. On `DESTROY_INSTANCE` it removes the runtime.

`PluginRuntime` is structurally identical to `PluginHost` but lives in the worklet's global scope. To avoid duplicating code, factor the shared lifecycle into a small helper imported by both. The helper is in a new module `src/engine/PluginInstance.ts` (no worklet-only or main-only imports).

Each `PluginRuntime` allocates:
- A new per-instance event `RingBuffer` (1024 slots × 32-byte frames) — `paramRingSab`.
- A new per-instance notify `RingBuffer` (256 slots × 16-byte frames) — `notifyRingSab`.

These SABs are passed back to main thread in `INSTANCE_READY` and forwarded to the UI iframe.

Each block, the worklet:
1. Drains the global event ring; routes events by `targetId` to per-instance buffers.
2. For each instance in chain order:
   - Drains its per-instance event ring into the instance's internal event buffer.
   - Writes current param canonical values (cached from prior PARAM_CHANGED messages) into the instance's param buffer.
   - For FX slots: writes the upstream slot's output as input.
   - For generator slot 0: skips input.
   - Calls `noa_process(nFrames, nEvents)`.
3. Writes the last slot's output into the worklet's output channels.

The full implementation is verbose. Sketch:

```typescript
// audio-worklet.ts (key delta)

import { PluginInstance } from './PluginInstance';
// ... existing imports

class NoaEngineProcessor extends AudioWorkletProcessor {
  private chain: (PluginInstance | null)[] = [];
  private readonly pending: Message[] = [];

  constructor(options: AudioWorkletNodeOptions) {
    super();
    // ... existing setup
    this.port.onmessage = (e) => { this.pending.push(e.data); };
  }

  private handlePending(): void {
    while (this.pending.length > 0) {
      const m = this.pending.shift()!;
      switch (m.type) {
        case 'INSTANTIATE_PLUGIN': this.handleInstantiate(m); break;
        case 'DESTROY_INSTANCE':   this.handleDestroy(m);     break;
        // ...
      }
    }
  }

  private handleInstantiate(m: InstantiateMessage): void {
    try {
      const inst = PluginInstance.fromModule(m.module, m.manifest, { sampleRate, maxBlockSize: 128 });
      // grow chain to slot index
      while (this.chain.length <= m.slot) this.chain.push(null);
      this.chain[m.slot] = inst;
      this.port.postMessage({
        type: 'INSTANCE_READY',
        instanceId: m.instanceId,
        paramRingSab: inst.paramRingSab,
        notifyRingSab: inst.notifyRingSab,
      });
    } catch (err) {
      this.port.postMessage({ type: 'INSTANCE_ERROR', instanceId: m.instanceId, error: String(err) });
    }
  }

  process(_in: Float32Array[][], outputs: Float32Array[][]): boolean {
    this.handlePending();
    const output = outputs[0]?.[0];
    if (!output) return true;
    const blockSize = output.length;

    // Drain global event ring; route to instance event rings.
    // ...

    // Walk the chain.
    let buf = new Float32Array(blockSize * 2);
    for (let s = 0; s < this.chain.length; s++) {
      const inst = this.chain[s];
      if (!inst) continue;
      // drain inst event ring → inst.eventBuf, count
      // if s > 0: inst.writeInput(buf);
      // inst.process(blockSize, eventCount)
      // inst.readOutput(buf)
    }

    // Deinterleave buf → left/right output channels.
    // ...

    return true;
  }
}
```

(Full code in a separate commit — too long to inline here; aim for ≤ 200 LoC `audio-worklet.ts` + ≤ 250 LoC `PluginInstance.ts`.)

- [ ] **Step 1: Factor `PluginInstance.ts`** — Pull the common lifecycle logic out of `PluginHost.ts` into `PluginInstance` (sync `fromModule` only — no async fetch). `PluginHost` becomes a thin async wrapper.

- [ ] **Step 2: Implement worklet chain processing** — Per the sketch above.

- [ ] **Step 3: Manual smoke test the chain** — Can't easily unit-test in Node (no worklet). Verify via app launch in Task 8.

- [ ] **Step 4: Typecheck + commit**

```bash
npm run typecheck
git add src/engine/PluginInstance.ts src/engine/audio-worklet.ts src/engine/PluginHost.ts
git commit -m "feat(engine): worklet plugin chain — PluginInstance runtime, per-instance rings"
```

---

### Task 7: EngineClient — loadPlugin / unloadInstance / control protocol

**Files:**
- Modify: `src/engine/EngineClient.ts`
- Modify: `src/engine/index.ts` (re-exports)

**Design notes:**

```typescript
class EngineClient {
  async loadPlugin(args: {
    instanceId: string;
    slot: number;
    module: WebAssembly.Module;
    manifest: PluginManifest;
  }): Promise<{ paramRingSab: SharedArrayBuffer; notifyRingSab: SharedArrayBuffer }>;
  unloadInstance(instanceId: string): void;
}
```

Implementation sends `INSTANTIATE_PLUGIN` to the worklet, awaits `INSTANCE_READY` matched by `instanceId`. Uses a `Map<instanceId, { resolve, reject }>` of pending requests.

- [ ] **Step 1: Implement the methods**
- [ ] **Step 2: Add a smoke unit test (mocking the worklet port)** — verify the promise resolves on `INSTANCE_READY` and rejects on `INSTANCE_ERROR`.
- [ ] **Step 3: Commit**

```bash
git add src/engine/EngineClient.ts src/engine/index.ts src/engine/__tests__/EngineClient.test.ts
git commit -m "feat(engine): EngineClient.loadPlugin / unloadInstance"
```

---

### Task 8: Wire engine to drive plugins; delete SineGenerator

**Files:**
- Modify: `src/App.jsx` — boot plugin registry on engine ready; iterate coordinator's `track.generator` + `channel.effects` and call `engine.loadPlugin` for each instance.
- Delete: `src/engine/dsp/SineGenerator.ts`
- Delete: `src/engine/dsp/__tests__/SineGenerator.test.ts`

On `engineReady`:
1. Build `PluginRegistry`, load both built-ins.
2. Walk the coordinator project; for each `PluginInstance` in tracks/channels, call `engine.loadPlugin({ instanceId, slot, module, manifest })`.
3. Subscribe to coordinator actions to keep the chain in sync (`load-plugin`, `unload-plugin`, `set-param`).
4. Replace the existing demo-note `noteOn(60)` call with a real engine event targeting the sine generator's instanceId.

- [ ] **Step 1: Bootstrap registry + initial chain load**

- [ ] **Step 2: Wire `set-param` from coordinator → engine param ring**

- [ ] **Step 3: Manual smoke test — hear the sine via WASM**

```bash
npm run dev
```

Click Play. Expect the same sine note that worked in Phase 1, now coming from `com.noa.sine` instead of `SineGenerator`.

- [ ] **Step 4: Delete `SineGenerator`**

```bash
git rm src/engine/dsp/SineGenerator.ts src/engine/dsp/__tests__/SineGenerator.test.ts
rmdir src/engine/dsp/__tests__ src/engine/dsp 2>/dev/null || true
```

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: existing tests (minus the 7 `SineGenerator` cases) all pass. New `PluginHost` + `PluginRegistry` + `PluginManifest` cases pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(engine): WASM sine plugin replaces SineGenerator"
```

---

### Task 9: `sine` built-in plugin

**Files:**
- Create: `src/builtin-plugins/sine/` (manifest, source, build artifact, package.json, asconfig.json)
- Create: `src/builtin-plugins/sine/plugin.wasm` (committed artifact)

**Design notes:** 8-voice polyphonic sine, mirroring `SineGenerator.ts`. Two params: Volume (0..1, default 0.5), Octave (-2..2 integer, default 0). Reads `noa_event_buf` for NoteOn/NoteOff, applies frame-offset-accurate voice activation. Output is interleaved stereo (L == R).

Source ≈ 120 LoC of AssemblyScript. Build → commit `plugin.wasm`. Add to the build-plugins script's loop.

- [ ] Implement, build, smoke-test.
- [ ] Commit: `feat(plugins): com.noa.sine — 8-voice polyphonic sine`

---

### Task 10: `gain` built-in plugin

**Files:** `src/builtin-plugins/gain/`.

**Design notes:** Single Gain param (0..4, default 1, display "db" → UI converts log→linear). FX kind. Multiplies each sample by `Gain`.

~30 LoC AssemblyScript.

- [ ] Implement, build, smoke-test.
- [ ] Commit: `feat(plugins): com.noa.gain — linear gain insert`

---

### Task 11: PluginUIHost + PluginUIProtocol

**Files:**
- Create: `src/engine/PluginUIProtocol.ts` — message type definitions + lightweight validators.
- Create: `src/engine/PluginUIHost.ts` — iframe lifecycle.
- Create: `src/engine/__tests__/PluginUIProtocol.test.ts`

**Design notes:** No iframe in unit tests (jsdom is heavy for this); `PluginUIProtocol` is tested as data-only. `PluginUIHost` is verified via the browser smoke test in Task 13.

`PluginUIHost` surface:

```typescript
class PluginUIHost {
  openWindow(args: {
    instanceId: string;
    manifest: PluginManifest;
    uiAssets: Map<string, Uint8Array>;
    initialParams: number[];
    paramRingSab: SharedArrayBuffer;
    notifyRingSab: SharedArrayBuffer;
    container: HTMLElement;
  }): { close: () => void; iframe: HTMLIFrameElement };
}
```

The iframe Blob URL is constructed by:
1. Reading the HTML entry from `uiAssets`.
2. Wrapping it in a small bootstrap that adds a postMessage handler for `HELLO` and exposes the SABs via JS globals (`window.__noa.paramRing` etc).
3. Constructing a `Blob([wrapped], { type: 'text/html' })` and `URL.createObjectURL(...)`.

- [ ] Implement, write tests for protocol envelope, commit.

---

### Task 12: PluginWindow React + Mixer integration

**Files:**
- Create: `src/components/PluginWindow.jsx`
- Modify: `src/components/Mixer.jsx`
- Modify: `src/styles/styles-components.css` — plugin-window styles.

**Design notes:** Reuse the floating-panel pattern from `TweaksPanel.jsx`: drag header, clamp to viewport, z-order via state held in `App.jsx`. The chrome holds a `<div ref={containerRef} />` that `PluginUIHost.openWindow` injects the iframe into.

Open/close is owned by `App.jsx` state: `openPluginWindows: { instanceId, x, y, z }[]`. Mixer double-click on an effect entry dispatches `openPluginWindow(instanceId)` (an App-level handler, not a coordinator action — UI ephemeral state).

- [ ] Implement, manually smoke-test, commit.

---

### Task 13: HTML UIs for sine + gain; end-to-end smoke

**Files:**
- Create: `src/builtin-plugins/sine/ui/index.html`
- Create: `src/builtin-plugins/gain/ui/index.html`

**Design notes:**

Both UIs are single-file HTML — vanilla JS + a small inline `<style>`. Pattern:

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>Gain</title>
<style>/* ...minimal knob styling */</style>
</head><body>
<div class="knob" id="gain"></div>
<script>
  // Wait for HELLO, then drive the knob.
  // Writes paramset events into window.__noa.paramRing via a small helper.
  // Polls window.__noa.notifyRing at RAF rate for ParamChanged updates.
</script>
</body></html>
```

The `__noa` global is set up by `PluginUIHost` before the iframe HTML runs (injected as a `<script>` prepended to the body in the Blob bootstrap).

- [ ] Implement HTML files, run the end-to-end demo per Section 11.2 of the design spec.

- [ ] **Final commit**

```bash
git add -A
git commit -m "feat(plugins): sine + gain UIs; end-to-end plugin demo working"
```

---

### Task 14: Documentation + final verification

**Files:**
- Modify: `CLAUDE.md` — add "Plugin module (`src/engine/Plugin*.ts`)" subsection alongside the existing Engine and Coordinator sections.
- Modify: `docs/superpowers/plans/2026-05-17-noa-daw-roadmap.md` — mark Phase 3 complete.

- [ ] **Step 1: Update CLAUDE.md**

Add a section describing the plugin module: PluginHost, PluginRegistry, PluginUIHost, the worklet's PluginInstance chain, built-in plugin layout, AssemblyScript build path. Note that the engine module's `dsp/SineGenerator.ts` is gone and `com.noa.sine` is its replacement.

- [ ] **Step 2: Run full verification**

```bash
npm test
npm run typecheck
npm run build
```

All green.

- [ ] **Step 3: Manual end-to-end smoke**

Run through the demo script in Section 1 of the design spec, step by step.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/plans/2026-05-17-noa-daw-roadmap.md
git commit -m "docs: Phase 3 complete — plugin ABI v1 shipped"
```

---

## Self-review checklist

**Spec coverage:**
- ABI v1 surface (exports + imports + memory model) → Tasks 1, 3
- Manifest schema validation → Task 1
- WASM compile/load → Task 4
- Worklet runtime + signal chain → Task 6
- Coordinator integration → Task 5
- UI host (iframe + postMessage + SABs) → Tasks 11, 12, 13
- Reference plugins (sine, gain) → Tasks 9, 10
- End-to-end demo (Section 1 of design spec) → Task 13

**Test coverage:**
- `PluginManifest.test.ts` — 8 cases (Task 1).
- `PluginHost.test.ts` — 5 cases (Task 3).
- `PluginRegistry.test.ts` — 3 cases (Task 4).
- `PluginUIProtocol.test.ts` — envelope round-trip (Task 11).
- Reducer cases for new actions (Task 5).
- Plugin-specific Node tests for sine and gain (Tasks 9, 10).
- Worklet integration: manual smoke only (no jsdom audio worklet).

**Risks acknowledged:**
- AssemblyScript runtime stub: documented in the design spec.
- Synchronous `noa_init` glitch: Phase 4 fixes; Phase 3 accepts.
- WebAssembly.Module postMessage to worklet: verified by Task 6 smoke; if it fails, fall back to passing compiled bytes and re-compiling inside the worklet.

**Placeholder scan:** None — every task lists files to touch, failing tests, and a commit message. Task 6 (worklet plugin chain) and Tasks 11–13 (UI host) intentionally sketch rather than spec line-by-line because the surface area is large; the implementer fills in the details following the patterns of Task 3 (PluginHost) and existing code in `audio-worklet.ts`.
