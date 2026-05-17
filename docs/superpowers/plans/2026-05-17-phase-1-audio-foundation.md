# Phase 1: Audio Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the simulated transport and meter loops in `App.jsx` with a real `AudioWorkletProcessor`-based engine, communicating via `SharedArrayBuffer` ring buffers, producing actual audio from a built-in sine generator triggered by the existing UI.

**Architecture:** Main thread `EngineClient` owns an `AudioContext` + `AudioWorkletNode`. Two SPSC ring buffers connect main↔worklet: one for `EngineEvent` frames (main→worklet), one for `MeterFrame` data (worklet→main). A small telemetry SAB carries the worklet's sample counter back for transport position. The worklet hosts a `SineGenerator` (headless, unit-testable DSP) that consumes events and writes to its output.

**Tech Stack:** TypeScript (scoped to `src/engine/`), Vitest, Vite (existing), AudioWorklet, SharedArrayBuffer, Atomics. React UI stays JSX.

**Existing state being replaced:**
- `App.jsx:36-52` — transport RAF loop (replaced by Task 10).
- `App.jsx:54-80` — meter simulation RAF loop (master replaced by Task 9; other channels stay simulated until Phase 6).
- `App.jsx:25` — `time` state (still in App, but driven by engine).
- `App.jsx:26` — `levels` state (master replaced; others unchanged).

**Deliberately out of scope:**
- Multi-track / per-channel audio routing (Phase 3 brings real plugins; until then the engine has a single global sine voice).
- Pattern playback (Phase 6 wires `clips`/`patterns` into the engine).
- BPM-driven note scheduling beyond the bare `Tempo` event (Phase 3+).

---

## File structure

**Create:**
- `tsconfig.json` (root, scoped to engine module)
- `vitest.config.ts`
- `src/engine/RingBuffer.ts` — SPSC ring buffer primitive
- `src/engine/EngineEvent.ts` — Event type constants + encode/decode
- `src/engine/dsp/SineGenerator.ts` — Headless DSP class
- `src/engine/audio-worklet.ts` — `AudioWorkletProcessor` wrapper
- `src/engine/EngineClient.ts` — Main-thread façade
- `src/engine/index.ts` — Public re-exports
- `src/engine/useEngine.js` — React hook (JS, used from `App.jsx`)
- `src/engine/__tests__/RingBuffer.test.ts`
- `src/engine/__tests__/EngineEvent.test.ts`
- `src/engine/dsp/__tests__/SineGenerator.test.ts`

**Modify:**
- `package.json` — add `typescript`, `vitest`, `@types/audioworklet`; add `test`, `typecheck` scripts
- `vite.config.js` — add COOP/COEP headers
- `src/App.jsx` — instantiate engine, wire Play/Stop/Tempo, replace transport loop, replace master meter

---

### Task 1: Add TypeScript + Vitest scaffolding

**Files:**
- Modify: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/engine/index.ts` (placeholder)

- [ ] **Step 1: Install dev dependencies**

Run:
```bash
npm install --save-dev typescript@^5.5.0 vitest@^2.1.0 @types/audioworklet@^0.0.60
```

Expected: dependencies added; `node_modules` updated. No code changes yet.

- [ ] **Step 2: Add scripts to `package.json`**

Edit `package.json` so the `scripts` block becomes exactly:

```json
"scripts": {
  "dev": "vite",
  "build": "vite build",
  "preview": "vite preview",
  "test": "vitest run",
  "test:watch": "vitest",
  "typecheck": "tsc --noEmit"
}
```

- [ ] **Step 3: Create `tsconfig.json`**

Create `tsconfig.json` at repo root with:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker"],
    "types": ["audioworklet", "vitest/globals"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "allowJs": false,
    "skipLibCheck": true,
    "noEmit": true,
    "jsx": "preserve"
  },
  "include": ["src/engine/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

Create `vitest.config.ts` at repo root:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/engine/**/__tests__/**/*.test.ts'],
  },
});
```

- [ ] **Step 5: Create `src/engine/index.ts` placeholder**

Create `src/engine/index.ts`:

```typescript
export {};
```

(Real exports added in later tasks; this keeps `tsc` happy.)

- [ ] **Step 6: Verify the scaffold runs**

Run:
```bash
npm test
```

Expected: Vitest starts, reports `No test files found`, exits 0. If it errors on missing config, re-check Step 4.

Run:
```bash
npm run typecheck
```

Expected: `tsc --noEmit` reports zero errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/engine/index.ts
git commit -m "build: scaffold TypeScript + Vitest for engine module"
```

---

### Task 2: COOP/COEP headers for crossOriginIsolated

**Files:**
- Modify: `vite.config.js`

- [ ] **Step 1: Update `vite.config.js`**

Replace the entire file with:

```javascript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    headers: isolationHeaders,
  },
  preview: {
    port: 5173,
    headers: isolationHeaders,
  },
});
```

- [ ] **Step 2: Manual verification — crossOriginIsolated is true**

Run:
```bash
npm run dev
```

Open `http://localhost:5173` in Chrome. Open DevTools console. Type:

```javascript
crossOriginIsolated
```

Expected: `true`.

Type:
```javascript
typeof SharedArrayBuffer
```

Expected: `"function"`.

If either fails: confirm both COOP and COEP headers are actually returned (Network tab → main document → Response Headers).

- [ ] **Step 3: Commit**

```bash
git add vite.config.js
git commit -m "build: enable crossOriginIsolated via COOP/COEP headers"
```

---

### Task 3: RingBuffer (SPSC over SharedArrayBuffer)

**Files:**
- Create: `src/engine/RingBuffer.ts`
- Create: `src/engine/__tests__/RingBuffer.test.ts`

**Design notes:**
- Header layout (16 bytes, `Uint32Array` view at offset 0):
  - `[0]` writeIndex (monotonic, never wraps; reader masks on access)
  - `[1]` readIndex (monotonic)
  - `[2]` capacity (constant after init; number of slots, power of 2)
  - `[3]` frameSize (constant after init; bytes per slot, must be multiple of 4)
- Data follows the header at byte offset 16.
- Full when `write - read >= capacity`; empty when `read === write`.
- Single producer / single consumer assumption — no compare-and-swap loops needed.

- [ ] **Step 1: Write failing tests**

Create `src/engine/__tests__/RingBuffer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { allocRingBuffer, RingBuffer, RB_HEADER_BYTES } from '../RingBuffer';

const FRAME = 8;

function makeFrame(byteValue: number): Uint8Array {
  return new Uint8Array(FRAME).fill(byteValue);
}

describe('allocRingBuffer', () => {
  it('rejects non-power-of-2 capacities', () => {
    expect(() => allocRingBuffer(3, FRAME)).toThrow(/power of 2/);
    expect(() => allocRingBuffer(0, FRAME)).toThrow();
  });

  it('rejects frame sizes that are not positive multiples of 4', () => {
    expect(() => allocRingBuffer(8, 0)).toThrow();
    expect(() => allocRingBuffer(8, 5)).toThrow();
  });

  it('writes capacity and frameSize into the header', () => {
    const { sab } = allocRingBuffer(8, FRAME);
    const header = new Uint32Array(sab, 0, 4);
    expect(header[2]).toBe(8);
    expect(header[3]).toBe(FRAME);
    expect(sab.byteLength).toBe(RB_HEADER_BYTES + 8 * FRAME);
  });
});

describe('RingBuffer push/pop', () => {
  it('starts empty', () => {
    const { sab } = allocRingBuffer(4, FRAME);
    const rb = new RingBuffer(sab);
    expect(rb.size()).toBe(0);
    expect(rb.pop(new Uint8Array(FRAME))).toBe(false);
  });

  it('round-trips a single frame', () => {
    const { sab } = allocRingBuffer(4, FRAME);
    const rb = new RingBuffer(sab);
    expect(rb.push(makeFrame(0xab))).toBe(true);
    expect(rb.size()).toBe(1);
    const out = new Uint8Array(FRAME);
    expect(rb.pop(out)).toBe(true);
    expect(Array.from(out)).toEqual(Array(FRAME).fill(0xab));
    expect(rb.size()).toBe(0);
  });

  it('rejects pushes when full and rejects pops when empty', () => {
    const { sab } = allocRingBuffer(4, FRAME);
    const rb = new RingBuffer(sab);
    for (let i = 0; i < 4; i++) expect(rb.push(makeFrame(i))).toBe(true);
    expect(rb.push(makeFrame(99))).toBe(false);
    const out = new Uint8Array(FRAME);
    for (let i = 0; i < 4; i++) {
      expect(rb.pop(out)).toBe(true);
      expect(out[0]).toBe(i);
    }
    expect(rb.pop(out)).toBe(false);
  });

  it('wraps past the capacity boundary', () => {
    const { sab } = allocRingBuffer(4, FRAME);
    const rb = new RingBuffer(sab);
    const out = new Uint8Array(FRAME);
    for (let cycle = 0; cycle < 10; cycle++) {
      expect(rb.push(makeFrame(cycle))).toBe(true);
      expect(rb.pop(out)).toBe(true);
      expect(out[0]).toBe(cycle);
    }
    expect(rb.size()).toBe(0);
  });

  it('two views over the same SAB see each others writes', () => {
    const { sab } = allocRingBuffer(8, FRAME);
    const producer = new RingBuffer(sab);
    const consumer = new RingBuffer(sab);
    producer.push(makeFrame(0x7e));
    const out = new Uint8Array(FRAME);
    expect(consumer.pop(out)).toBe(true);
    expect(out[0]).toBe(0x7e);
  });

  it('throws on frame size mismatch', () => {
    const { sab } = allocRingBuffer(4, FRAME);
    const rb = new RingBuffer(sab);
    expect(() => rb.push(new Uint8Array(FRAME + 1))).toThrow(/frame size/);
    expect(() => rb.pop(new Uint8Array(FRAME - 4))).toThrow(/frame size/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npm test -- RingBuffer
```

Expected: FAIL with module-resolution error (`RingBuffer.ts` doesn't exist yet).

- [ ] **Step 3: Implement `RingBuffer.ts`**

Create `src/engine/RingBuffer.ts`:

```typescript
export const RB_HEADER_BYTES = 16;

const W_IDX = 0;
const R_IDX = 1;
const CAP_IDX = 2;
const FRAME_IDX = 3;

export interface RingBufferLayout {
  sab: SharedArrayBuffer;
  capacity: number;
  frameSize: number;
}

function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

export function allocRingBuffer(capacity: number, frameSize: number): RingBufferLayout {
  if (!isPow2(capacity)) {
    throw new Error(`RingBuffer capacity must be a power of 2 (got ${capacity})`);
  }
  if (!Number.isInteger(frameSize) || frameSize <= 0 || frameSize % 4 !== 0) {
    throw new Error(`RingBuffer frameSize must be a positive multiple of 4 (got ${frameSize})`);
  }
  const bytes = RB_HEADER_BYTES + capacity * frameSize;
  const sab = new SharedArrayBuffer(bytes);
  const header = new Uint32Array(sab, 0, 4);
  header[CAP_IDX] = capacity;
  header[FRAME_IDX] = frameSize;
  return { sab, capacity, frameSize };
}

export class RingBuffer {
  private readonly header: Uint32Array;
  private readonly data: Uint8Array;
  private readonly mask: number;
  readonly capacity: number;
  readonly frameSize: number;

  constructor(sab: SharedArrayBuffer) {
    this.header = new Uint32Array(sab, 0, 4);
    this.capacity = Atomics.load(this.header, CAP_IDX);
    this.frameSize = Atomics.load(this.header, FRAME_IDX);
    if (!isPow2(this.capacity)) {
      throw new Error(`RingBuffer SAB header is malformed (capacity=${this.capacity})`);
    }
    this.mask = this.capacity - 1;
    this.data = new Uint8Array(sab, RB_HEADER_BYTES, this.capacity * this.frameSize);
  }

  push(frame: Uint8Array): boolean {
    if (frame.length !== this.frameSize) {
      throw new Error(`RingBuffer frame size mismatch: expected ${this.frameSize}, got ${frame.length}`);
    }
    const write = Atomics.load(this.header, W_IDX);
    const read = Atomics.load(this.header, R_IDX);
    if (write - read >= this.capacity) return false;
    const slot = (write & this.mask) * this.frameSize;
    this.data.set(frame, slot);
    Atomics.store(this.header, W_IDX, write + 1);
    return true;
  }

  pop(out: Uint8Array): boolean {
    if (out.length !== this.frameSize) {
      throw new Error(`RingBuffer frame size mismatch: expected ${this.frameSize}, got ${out.length}`);
    }
    const write = Atomics.load(this.header, W_IDX);
    const read = Atomics.load(this.header, R_IDX);
    if (read === write) return false;
    const slot = (read & this.mask) * this.frameSize;
    out.set(this.data.subarray(slot, slot + this.frameSize));
    Atomics.store(this.header, R_IDX, read + 1);
    return true;
  }

  size(): number {
    const write = Atomics.load(this.header, W_IDX);
    const read = Atomics.load(this.header, R_IDX);
    return write - read;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npm test -- RingBuffer
```

Expected: all 8 tests pass.

- [ ] **Step 5: Typecheck**

Run:
```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/engine/RingBuffer.ts src/engine/__tests__/RingBuffer.test.ts
git commit -m "feat(engine): SPSC RingBuffer over SharedArrayBuffer"
```

---

### Task 4: EngineEvent binary protocol

**Files:**
- Create: `src/engine/EngineEvent.ts`
- Create: `src/engine/__tests__/EngineEvent.test.ts`

**Event frame layout (32 bytes, little-endian):**

| Bytes  | Field         | Notes                                                      |
|--------|---------------|------------------------------------------------------------|
| 0      | type (u8)     | `EVT_NOTE_ON`=1, `EVT_NOTE_OFF`=2, `EVT_PARAM_SET`=3, `EVT_TRANSPORT`=4, `EVT_TEMPO`=5 |
| 1      | flags (u8)    | reserved, currently 0                                      |
| 2..4   | reserved      | currently 0                                                |
| 4..8   | frameOffset (u32) | sample-accurate offset within an audio block             |
| 8..32  | payload (24B) | type-specific                                              |

**Payload layouts (bytes 8..32):**
- NoteOn: `targetId u32 @8`, `note u8 @12`, `velocity u8 @13`, `channel u8 @14`
- NoteOff: `targetId u32 @8`, `note u8 @12`, `channel u8 @13`
- ParamSet: `targetId u32 @8`, `paramIndex u32 @12`, `value f32 @16`
- Transport: `command u8 @8` (`0`=stop, `1`=play, `2`=pause), `positionBeats f64 @16`
- Tempo: `bpm f32 @8`

- [ ] **Step 1: Write failing tests**

Create `src/engine/__tests__/EngineEvent.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  EVENT_FRAME_SIZE,
  EVT_NOTE_ON, EVT_NOTE_OFF, EVT_PARAM_SET, EVT_TRANSPORT, EVT_TEMPO,
  TRANSPORT_PLAY, TRANSPORT_STOP,
  encodeEvent, decodeEvent,
  type EngineEvent,
} from '../EngineEvent';

function roundTrip(ev: EngineEvent): EngineEvent {
  const buf = new Uint8Array(EVENT_FRAME_SIZE);
  encodeEvent(ev, buf);
  return decodeEvent(buf);
}

describe('EngineEvent', () => {
  it('frame size is 32 bytes', () => {
    expect(EVENT_FRAME_SIZE).toBe(32);
  });

  it('round-trips NoteOn', () => {
    const ev: EngineEvent = {
      type: EVT_NOTE_ON, frameOffset: 17, targetId: 42, note: 60, velocity: 100, channel: 2,
    };
    expect(roundTrip(ev)).toEqual(ev);
  });

  it('round-trips NoteOff', () => {
    const ev: EngineEvent = {
      type: EVT_NOTE_OFF, frameOffset: 0, targetId: 7, note: 64, channel: 0,
    };
    expect(roundTrip(ev)).toEqual(ev);
  });

  it('round-trips ParamSet with full f32 precision', () => {
    const ev: EngineEvent = {
      type: EVT_PARAM_SET, frameOffset: 99, targetId: 3, paramIndex: 12, value: 0.5,
    };
    expect(roundTrip(ev)).toEqual(ev);
  });

  it('round-trips Transport with f64 position', () => {
    const ev: EngineEvent = {
      type: EVT_TRANSPORT, frameOffset: 0, command: TRANSPORT_PLAY, positionBeats: 17.3125,
    };
    expect(roundTrip(ev)).toEqual(ev);
  });

  it('round-trips a stop event', () => {
    const ev: EngineEvent = {
      type: EVT_TRANSPORT, frameOffset: 0, command: TRANSPORT_STOP, positionBeats: 0,
    };
    expect(roundTrip(ev)).toEqual(ev);
  });

  it('round-trips Tempo', () => {
    const ev: EngineEvent = { type: EVT_TEMPO, frameOffset: 0, bpm: 124 };
    expect(roundTrip(ev)).toEqual(ev);
  });

  it('rejects buffers of the wrong size', () => {
    const ev: EngineEvent = {
      type: EVT_NOTE_ON, frameOffset: 0, targetId: 0, note: 60, velocity: 100, channel: 0,
    };
    expect(() => encodeEvent(ev, new Uint8Array(31))).toThrow();
  });

  it('throws on unknown type byte during decode', () => {
    const buf = new Uint8Array(EVENT_FRAME_SIZE);
    buf[0] = 99;
    expect(() => decodeEvent(buf)).toThrow(/unknown event type/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npm test -- EngineEvent
```

Expected: FAIL with module-resolution error.

- [ ] **Step 3: Implement `EngineEvent.ts`**

Create `src/engine/EngineEvent.ts`:

```typescript
export const EVENT_FRAME_SIZE = 32;

export const EVT_NOTE_ON = 1 as const;
export const EVT_NOTE_OFF = 2 as const;
export const EVT_PARAM_SET = 3 as const;
export const EVT_TRANSPORT = 4 as const;
export const EVT_TEMPO = 5 as const;

export const TRANSPORT_STOP = 0 as const;
export const TRANSPORT_PLAY = 1 as const;
export const TRANSPORT_PAUSE = 2 as const;

export interface NoteOnEvent {
  type: typeof EVT_NOTE_ON;
  frameOffset: number;
  targetId: number;
  note: number;
  velocity: number;
  channel: number;
}

export interface NoteOffEvent {
  type: typeof EVT_NOTE_OFF;
  frameOffset: number;
  targetId: number;
  note: number;
  channel: number;
}

export interface ParamSetEvent {
  type: typeof EVT_PARAM_SET;
  frameOffset: number;
  targetId: number;
  paramIndex: number;
  value: number;
}

export interface TransportEvent {
  type: typeof EVT_TRANSPORT;
  frameOffset: number;
  command: number;
  positionBeats: number;
}

export interface TempoEvent {
  type: typeof EVT_TEMPO;
  frameOffset: number;
  bpm: number;
}

export type EngineEvent =
  | NoteOnEvent | NoteOffEvent | ParamSetEvent | TransportEvent | TempoEvent;

function viewOf(buf: Uint8Array): DataView {
  if (buf.length !== EVENT_FRAME_SIZE) {
    throw new Error(`EngineEvent buffer must be ${EVENT_FRAME_SIZE} bytes (got ${buf.length})`);
  }
  return new DataView(buf.buffer, buf.byteOffset, EVENT_FRAME_SIZE);
}

export function encodeEvent(ev: EngineEvent, out: Uint8Array): void {
  const v = viewOf(out);
  // Zero the payload region so old data never leaks into decode comparisons.
  for (let i = 8; i < EVENT_FRAME_SIZE; i++) out[i] = 0;
  v.setUint8(0, ev.type);
  v.setUint8(1, 0);
  v.setUint16(2, 0, true);
  v.setUint32(4, ev.frameOffset, true);
  switch (ev.type) {
    case EVT_NOTE_ON:
      v.setUint32(8, ev.targetId, true);
      v.setUint8(12, ev.note);
      v.setUint8(13, ev.velocity);
      v.setUint8(14, ev.channel);
      return;
    case EVT_NOTE_OFF:
      v.setUint32(8, ev.targetId, true);
      v.setUint8(12, ev.note);
      v.setUint8(13, ev.channel);
      return;
    case EVT_PARAM_SET:
      v.setUint32(8, ev.targetId, true);
      v.setUint32(12, ev.paramIndex, true);
      v.setFloat32(16, ev.value, true);
      return;
    case EVT_TRANSPORT:
      v.setUint8(8, ev.command);
      v.setFloat64(16, ev.positionBeats, true);
      return;
    case EVT_TEMPO:
      v.setFloat32(8, ev.bpm, true);
      return;
  }
}

export function decodeEvent(buf: Uint8Array): EngineEvent {
  const v = viewOf(buf);
  const type = v.getUint8(0);
  const frameOffset = v.getUint32(4, true);
  switch (type) {
    case EVT_NOTE_ON:
      return {
        type: EVT_NOTE_ON, frameOffset,
        targetId: v.getUint32(8, true),
        note: v.getUint8(12),
        velocity: v.getUint8(13),
        channel: v.getUint8(14),
      };
    case EVT_NOTE_OFF:
      return {
        type: EVT_NOTE_OFF, frameOffset,
        targetId: v.getUint32(8, true),
        note: v.getUint8(12),
        channel: v.getUint8(13),
      };
    case EVT_PARAM_SET:
      return {
        type: EVT_PARAM_SET, frameOffset,
        targetId: v.getUint32(8, true),
        paramIndex: v.getUint32(12, true),
        value: v.getFloat32(16, true),
      };
    case EVT_TRANSPORT:
      return {
        type: EVT_TRANSPORT, frameOffset,
        command: v.getUint8(8),
        positionBeats: v.getFloat64(16, true),
      };
    case EVT_TEMPO:
      return {
        type: EVT_TEMPO, frameOffset,
        bpm: v.getFloat32(8, true),
      };
    default:
      throw new Error(`unknown event type: ${type}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npm test -- EngineEvent
```

Expected: all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/EngineEvent.ts src/engine/__tests__/EngineEvent.test.ts
git commit -m "feat(engine): binary EngineEvent encoding (32-byte frames)"
```

---

### Task 5: SineGenerator (headless DSP)

**Files:**
- Create: `src/engine/dsp/SineGenerator.ts`
- Create: `src/engine/dsp/__tests__/SineGenerator.test.ts`

**Design:** 8-voice polyphonic sine. Each `NoteOn` claims an inactive voice (or steals voice 0 if all active). `NoteOff` flags matching voices for linear release at `1e-3` amp/frame. Voice amplitude scales with velocity. Output is summed into a single Float32 buffer.

- [ ] **Step 1: Write failing tests**

Create `src/engine/dsp/__tests__/SineGenerator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SineGenerator } from '../SineGenerator';
import {
  EVT_NOTE_ON, EVT_NOTE_OFF, type EngineEvent,
} from '../../EngineEvent';

const SR = 48000;

function noteOn(note: number, velocity: number, frameOffset = 0): EngineEvent {
  return { type: EVT_NOTE_ON, frameOffset, targetId: 0, note, velocity, channel: 0 };
}
function noteOff(note: number, frameOffset = 0): EngineEvent {
  return { type: EVT_NOTE_OFF, frameOffset, targetId: 0, note, channel: 0 };
}

function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / buf.length);
}

describe('SineGenerator', () => {
  it('produces silence with no notes', () => {
    const g = new SineGenerator(SR);
    const out = new Float32Array(128);
    g.process([], out);
    expect(rms(out)).toBe(0);
  });

  it('produces non-zero output after NoteOn', () => {
    const g = new SineGenerator(SR);
    const out = new Float32Array(2048);
    g.process([noteOn(69, 100)], out);
    expect(rms(out)).toBeGreaterThan(0.01);
  });

  it('NoteOn frequency approximates the MIDI pitch (A4 = 440 Hz)', () => {
    const g = new SineGenerator(SR);
    const out = new Float32Array(SR); // 1 second
    g.process([noteOn(69, 127)], out);
    // Count zero crossings on the positive-going edge.
    let crossings = 0;
    for (let i = 1; i < out.length; i++) {
      if (out[i - 1]! <= 0 && out[i]! > 0) crossings++;
    }
    expect(crossings).toBeGreaterThan(420);
    expect(crossings).toBeLessThan(460);
  });

  it('NoteOff causes amplitude decay to zero', () => {
    const g = new SineGenerator(SR);
    const a = new Float32Array(1024);
    g.process([noteOn(60, 127)], a);
    const before = rms(a);
    const b = new Float32Array(4096);
    g.process([noteOff(60)], b);
    // Tail of the buffer should be (near) silent after release.
    const tail = b.subarray(b.length - 256);
    expect(rms(tail)).toBeLessThan(before * 0.05);
  });

  it('honors frameOffset for within-block timing', () => {
    const g = new SineGenerator(SR);
    const out = new Float32Array(256);
    g.process([noteOn(69, 127, 128)], out);
    // Samples before frameOffset should be silent.
    const head = out.subarray(0, 128);
    const tail = out.subarray(128);
    expect(rms(head)).toBe(0);
    expect(rms(tail)).toBeGreaterThan(0.01);
  });

  it('supports multiple simultaneous voices', () => {
    const g = new SineGenerator(SR);
    const out = new Float32Array(2048);
    g.process([noteOn(60, 100), noteOn(64, 100), noteOn(67, 100)], out);
    // Three voices summed should produce greater RMS than one.
    const g1 = new SineGenerator(SR);
    const out1 = new Float32Array(2048);
    g1.process([noteOn(60, 100)], out1);
    expect(rms(out)).toBeGreaterThan(rms(out1));
  });

  it('ignores unrelated event types without throwing', () => {
    const g = new SineGenerator(SR);
    const out = new Float32Array(128);
    g.process([{ type: 4 as const, frameOffset: 0, command: 1, positionBeats: 0 }], out);
    expect(rms(out)).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npm test -- SineGenerator
```

Expected: FAIL with module-resolution error.

- [ ] **Step 3: Implement `SineGenerator.ts`**

Create `src/engine/dsp/SineGenerator.ts`:

```typescript
import {
  EVT_NOTE_ON, EVT_NOTE_OFF,
  type EngineEvent,
} from '../EngineEvent';

const MAX_VOICES = 8;
const RELEASE_PER_SAMPLE = 1e-3;
const MASTER_TRIM = 0.5;

interface Voice {
  active: boolean;
  releasing: boolean;
  note: number;
  freq: number;
  phase: number;
  amp: number;
}

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function makeVoice(): Voice {
  return { active: false, releasing: false, note: 0, freq: 0, phase: 0, amp: 0 };
}

export class SineGenerator {
  private readonly voices: Voice[] = Array.from({ length: MAX_VOICES }, makeVoice);
  private readonly sampleRate: number;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  process(events: readonly EngineEvent[], output: Float32Array): void {
    const blockSize = output.length;
    let eventIdx = 0;

    for (let i = 0; i < blockSize; i++) {
      while (eventIdx < events.length && events[eventIdx]!.frameOffset <= i) {
        this.applyEvent(events[eventIdx]!);
        eventIdx++;
      }

      let sample = 0;
      for (let vi = 0; vi < MAX_VOICES; vi++) {
        const v = this.voices[vi]!;
        if (!v.active) continue;
        sample += Math.sin(v.phase * Math.PI * 2) * v.amp;
        v.phase += v.freq / this.sampleRate;
        if (v.phase >= 1) v.phase -= 1;
        if (v.releasing) {
          v.amp -= RELEASE_PER_SAMPLE;
          if (v.amp <= 0) {
            v.active = false;
            v.releasing = false;
            v.amp = 0;
          }
        }
      }
      output[i] = sample * MASTER_TRIM;
    }

    // Drain any remaining events at or beyond blockSize (rare, but possible
    // if the producer queued a future-offset event).
    while (eventIdx < events.length) {
      this.applyEvent(events[eventIdx]!);
      eventIdx++;
    }
  }

  private applyEvent(ev: EngineEvent): void {
    if (ev.type === EVT_NOTE_ON) {
      const slot =
        this.voices.find((v) => !v.active) ??
        this.voices[0]!;
      slot.active = true;
      slot.releasing = false;
      slot.note = ev.note;
      slot.freq = midiToFreq(ev.note);
      slot.amp = (ev.velocity / 127);
      slot.phase = 0;
    } else if (ev.type === EVT_NOTE_OFF) {
      for (const v of this.voices) {
        if (v.active && v.note === ev.note) v.releasing = true;
      }
    }
    // All other event types are ignored at this layer.
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npm test
```

Expected: all tests pass across all three suites (RingBuffer, EngineEvent, SineGenerator).

- [ ] **Step 5: Commit**

```bash
git add src/engine/dsp/SineGenerator.ts src/engine/dsp/__tests__/SineGenerator.test.ts
git commit -m "feat(engine): headless SineGenerator DSP with 8-voice polyphony"
```

---

### Task 6: AudioWorkletProcessor wrapper

**Files:**
- Create: `src/engine/audio-worklet.ts`

No unit tests — `AudioWorkletProcessor` and `registerProcessor` only exist in `AudioWorkletGlobalScope`. Verification is the in-browser smoke test in Task 8.

- [ ] **Step 1: Create the worklet file**

Create `src/engine/audio-worklet.ts`:

```typescript
/// <reference types="@types/audioworklet" />
import { RingBuffer } from './RingBuffer';
import { EVENT_FRAME_SIZE, decodeEvent, type EngineEvent } from './EngineEvent';
import { SineGenerator } from './dsp/SineGenerator';

const METER_FRAME_SIZE = 16;

interface NoaProcessorOptions {
  eventSab: SharedArrayBuffer;
  meterSab: SharedArrayBuffer;
  telemetrySab: SharedArrayBuffer;
}

class NoaEngineProcessor extends AudioWorkletProcessor {
  private readonly eventRing: RingBuffer;
  private readonly meterRing: RingBuffer;
  private readonly telemetry: Uint32Array;
  private readonly generator: SineGenerator;
  private readonly eventFrame = new Uint8Array(EVENT_FRAME_SIZE);
  private readonly meterFrame = new Uint8Array(METER_FRAME_SIZE);
  private readonly meterView = new DataView(this.meterFrame.buffer);
  private sampleCounter = 0;
  private blockCounter = 0;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const p = options.processorOptions as NoaProcessorOptions;
    this.eventRing = new RingBuffer(p.eventSab);
    this.meterRing = new RingBuffer(p.meterSab);
    this.telemetry = new Uint32Array(p.telemetrySab);
    this.generator = new SineGenerator(sampleRate);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const left = output[0];
    const right = output[1];
    const blockSize = left.length;

    // Drain queued events for this block.
    const events: EngineEvent[] = [];
    while (this.eventRing.pop(this.eventFrame)) {
      events.push(decodeEvent(this.eventFrame));
    }

    this.generator.process(events, left);
    if (right) right.set(left);

    // Compute peak & RMS and publish a meter frame.
    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < blockSize; i++) {
      const s = left[i]!;
      const a = s < 0 ? -s : s;
      if (a > peak) peak = a;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / blockSize);
    this.meterView.setUint32(0, 0, true); // channel 0 = master
    this.meterView.setFloat32(4, peak, true);
    this.meterView.setFloat32(8, rms, true);
    this.meterView.setUint32(12, this.blockCounter, true);
    this.meterRing.push(this.meterFrame);

    // Advance counters and publish telemetry (sample-count low 32 bits).
    this.sampleCounter += blockSize;
    Atomics.store(this.telemetry, 0, this.sampleCounter >>> 0);
    this.blockCounter++;

    return true;
  }
}

registerProcessor('noa-engine', NoaEngineProcessor);
```

- [ ] **Step 2: Typecheck**

Run:
```bash
npm run typecheck
```

Expected: zero errors. If `AudioWorkletProcessor`/`registerProcessor`/`sampleRate` are unresolved, confirm `@types/audioworklet` is in `tsconfig.json`'s `types` array.

- [ ] **Step 3: Commit**

```bash
git add src/engine/audio-worklet.ts
git commit -m "feat(engine): AudioWorkletProcessor draining event ring, publishing meters"
```

---

### Task 7: EngineClient (main-thread façade)

**Files:**
- Create: `src/engine/EngineClient.ts`
- Modify: `src/engine/index.ts` — re-export public surface.

- [ ] **Step 1: Implement `EngineClient.ts`**

Create `src/engine/EngineClient.ts`:

```typescript
import { allocRingBuffer, RingBuffer } from './RingBuffer';
import {
  EVENT_FRAME_SIZE,
  encodeEvent,
  EVT_NOTE_ON, EVT_NOTE_OFF, EVT_TEMPO, EVT_TRANSPORT,
  TRANSPORT_PLAY, TRANSPORT_STOP,
  type EngineEvent,
} from './EngineEvent';

const METER_FRAME_SIZE = 16;
const EVENT_RING_SLOTS = 1024;
const METER_RING_SLOTS = 256;

export interface MeterReading {
  channelId: number;
  peak: number;
  rms: number;
  blockCounter: number;
}

export class EngineClient {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private eventRing: RingBuffer | null = null;
  private meterRing: RingBuffer | null = null;
  private telemetry: Uint32Array | null = null;
  private readonly eventFrame = new Uint8Array(EVENT_FRAME_SIZE);
  private readonly meterFrame = new Uint8Array(METER_FRAME_SIZE);
  private readonly meterView = new DataView(this.meterFrame.buffer);

  async init(workletUrl: string | URL): Promise<void> {
    if (typeof crossOriginIsolated !== 'undefined' && !crossOriginIsolated) {
      throw new Error(
        'EngineClient requires crossOriginIsolated; check COOP/COEP headers in vite.config.js',
      );
    }
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule(workletUrl);

    const eventLayout = allocRingBuffer(EVENT_RING_SLOTS, EVENT_FRAME_SIZE);
    const meterLayout = allocRingBuffer(METER_RING_SLOTS, METER_FRAME_SIZE);
    const telemetrySab = new SharedArrayBuffer(4);

    this.eventRing = new RingBuffer(eventLayout.sab);
    this.meterRing = new RingBuffer(meterLayout.sab);
    this.telemetry = new Uint32Array(telemetrySab);

    this.node = new AudioWorkletNode(this.ctx, 'noa-engine', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        eventSab: eventLayout.sab,
        meterSab: meterLayout.sab,
        telemetrySab,
      },
    });
    this.node.connect(this.ctx.destination);
  }

  /** AudioContext starts suspended in most browsers; call from a user gesture. */
  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
  }

  get sampleRate(): number {
    if (!this.ctx) throw new Error('EngineClient not initialized');
    return this.ctx.sampleRate;
  }

  sendEvent(ev: EngineEvent): boolean {
    if (!this.eventRing) throw new Error('EngineClient not initialized');
    encodeEvent(ev, this.eventFrame);
    return this.eventRing.push(this.eventFrame);
  }

  noteOn(note: number, velocity = 100): void {
    this.sendEvent({
      type: EVT_NOTE_ON, frameOffset: 0, targetId: 0, note, velocity, channel: 0,
    });
  }

  noteOff(note: number): void {
    this.sendEvent({
      type: EVT_NOTE_OFF, frameOffset: 0, targetId: 0, note, channel: 0,
    });
  }

  play(positionBeats = 0): void {
    this.sendEvent({
      type: EVT_TRANSPORT, frameOffset: 0, command: TRANSPORT_PLAY, positionBeats,
    });
  }

  stop(): void {
    this.sendEvent({
      type: EVT_TRANSPORT, frameOffset: 0, command: TRANSPORT_STOP, positionBeats: 0,
    });
  }

  setTempo(bpm: number): void {
    this.sendEvent({ type: EVT_TEMPO, frameOffset: 0, bpm });
  }

  /** Drains every queued meter frame into `out`. */
  readMeters(out: MeterReading[]): void {
    if (!this.meterRing) return;
    out.length = 0;
    while (this.meterRing.pop(this.meterFrame)) {
      out.push({
        channelId: this.meterView.getUint32(0, true),
        peak: this.meterView.getFloat32(4, true),
        rms: this.meterView.getFloat32(8, true),
        blockCounter: this.meterView.getUint32(12, true),
      });
    }
  }

  /** Worklet's sample counter, low 32 bits. Wraps after ~24h at 48k — fine for Phase 1 UI. */
  currentSamplePosition(): number {
    return this.telemetry ? Atomics.load(this.telemetry, 0) : 0;
  }

  async dispose(): Promise<void> {
    this.node?.disconnect();
    this.node = null;
    await this.ctx?.close();
    this.ctx = null;
    this.eventRing = null;
    this.meterRing = null;
    this.telemetry = null;
  }
}
```

- [ ] **Step 2: Update `src/engine/index.ts` to re-export**

Replace the contents of `src/engine/index.ts` with:

```typescript
export { EngineClient, type MeterReading } from './EngineClient';
export {
  EVT_NOTE_ON, EVT_NOTE_OFF, EVT_PARAM_SET, EVT_TRANSPORT, EVT_TEMPO,
  TRANSPORT_STOP, TRANSPORT_PLAY, TRANSPORT_PAUSE,
  type EngineEvent,
} from './EngineEvent';
```

- [ ] **Step 3: Typecheck**

Run:
```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/engine/EngineClient.ts src/engine/index.ts
git commit -m "feat(engine): EngineClient main-thread façade"
```

---

### Task 8: Wire engine to App.jsx (Play / Stop / first audio)

**Files:**
- Create: `src/engine/useEngine.js`
- Modify: `src/App.jsx`

`useEngine.js` is intentionally JS — it's consumed from JSX and stays simple. Engine modules under `src/engine/*.ts` are imported transparently (Vite handles TS).

- [ ] **Step 1: Create the React hook**

Create `src/engine/useEngine.js`:

```javascript
import { useEffect, useRef, useState } from 'react';
import { EngineClient } from './EngineClient';

export function useEngine() {
  const ref = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const engine = new EngineClient();
    const workletUrl = new URL('./audio-worklet.ts', import.meta.url);
    engine
      .init(workletUrl)
      .then(() => {
        if (cancelled) {
          engine.dispose();
          return;
        }
        ref.current = engine;
        setReady(true);
      })
      .catch((e) => {
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
      ref.current?.dispose();
      ref.current = null;
    };
  }, []);

  return { engineRef: ref, ready, error };
}
```

- [ ] **Step 2: Wire into `App.jsx`**

In `src/App.jsx`, add this import near the existing imports (around line 8):

```javascript
import { useEngine } from './engine/useEngine.js';
```

Inside the `App` component, just after `const [levels, setLevels] = useState({});` (line 26), add:

```javascript
  const { engineRef, ready: engineReady, error: engineError } = useEngine();
```

Replace `handlePlay`, `handleStop`, and `handleRecord` (lines 84-86) with:

```javascript
  const handlePlay = useCallback(async () => {
    const engine = engineRef.current;
    if (engine) await engine.resume();
    setPlaying((prev) => {
      const next = !prev;
      if (engine) (next ? engine.play(time) : engine.stop());
      return next;
    });
  }, [engineRef, time]);

  const handleStop = useCallback(() => {
    setPlaying(false);
    setTime(0);
    engineRef.current?.stop();
  }, [engineRef]);

  const handleRecord = useCallback(() => {
    setRecording((r) => !r);
    setPlaying((p) => (!p ? true : p));
  }, []);
```

Wire BPM changes — find the `onBpm={setBpm}` prop on `<Toolbar>` (line 189) and replace it with:

```javascript
        onBpm={(b) => {
          setBpm(b);
          engineRef.current?.setTempo(b);
        }}
```

Push the initial tempo once the engine becomes ready. Right under the `useEngine()` call, add:

```javascript
  useEffect(() => {
    if (engineReady) engineRef.current?.setTempo(bpm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineReady]);
```

For a temporary audible test, add a one-shot demo note when Play is pressed. Inside `handlePlay`, after `engine.play(time)` is invoked, also call:

```javascript
        if (next && engine) {
          engine.noteOn(60, 100);
          setTimeout(() => engine.noteOff(60), 800);
        }
```

The final `handlePlay` should look like:

```javascript
  const handlePlay = useCallback(async () => {
    const engine = engineRef.current;
    if (engine) await engine.resume();
    setPlaying((prev) => {
      const next = !prev;
      if (engine) {
        if (next) {
          engine.play(time);
          engine.noteOn(60, 100);
          setTimeout(() => engine.noteOff(60), 800);
        } else {
          engine.stop();
        }
      }
      return next;
    });
  }, [engineRef, time]);
```

(This demo note is removed in Phase 3 when real plugins/patterns take over.)

- [ ] **Step 3: Manual smoke test — hear the sine**

Run:
```bash
npm run dev
```

Open `http://localhost:5173` in Chrome. Open DevTools.

- Console: type `crossOriginIsolated` → expect `true`.
- Console: no red errors during page load.
- Click the Play button in the toolbar.

**Expected:**
- A short sustained sine wave (~0.8s) plays at C4 (~262 Hz).
- Console shows no errors.
- Toolbar's playing indicator switches state.

**If silent:** check Network tab → confirm `audio-worklet.ts` was fetched as a separate module. Check console for "Cannot find name 'AudioWorkletProcessor'" — that means the worklet didn't load. Verify the `new URL('./audio-worklet.ts', import.meta.url)` form in `useEngine.js`.

- [ ] **Step 4: Commit**

```bash
git add src/engine/useEngine.js src/App.jsx
git commit -m "feat: wire engine to Play/Stop with demo note"
```

---

### Task 9: Master meter from real engine output

**Files:**
- Modify: `src/App.jsx`

The existing meter simulation in `App.jsx:54-80` writes a fake `levels['m0']` and `levels['m0_r']` for the master channel. We replace just the master values with real `peak`/`rms` from the engine; other channels stay simulated until later phases.

- [ ] **Step 1: Add meter draining alongside the simulation**

In `App.jsx`, locate the second `useEffect` (the simulation loop starting at line 54). Replace **only the inner `if (playing)` branch** so master values are overwritten with engine readings. The simulation block becomes:

```javascript
  const meterScratchRef = useRef([]);
  useEffect(() => {
    let raf;
    const tick = () => {
      const t = performance.now() / 1000;
      const beat = time;
      const newLevels = {};
      if (playing) {
        channels.forEach((ch) => {
          if (ch.mute) { newLevels[ch.id] = 0; return; }
          const phase = (beat + (ch.id.charCodeAt(1) || 0) * 0.13) * Math.PI;
          let base = 0.35 + Math.abs(Math.sin(phase * 2)) * 0.5 * ch.vol;
          if (ch.name === 'Kick')  base = 0.4 + Math.pow(Math.abs(Math.sin(beat * Math.PI)), 6) * 0.6 * ch.vol;
          if (ch.name === 'Snare') base = 0.2 + (beat % 2 < 0.2 ? 0.7 : 0) * ch.vol;
          if (ch.name === 'Hats')  base = 0.15 + Math.abs(Math.sin(beat * 8 + Math.random() * 0.5)) * 0.4 * ch.vol;
          if (ch.name === 'Master') base = 0;
          newLevels[ch.id] = Math.max(0, Math.min(1, base));
          newLevels[ch.id + '_r'] = Math.max(0, Math.min(1, base * (0.85 + Math.sin(t * 4 + ch.vol) * 0.1)));
        });
      } else {
        channels.forEach((ch) => { newLevels[ch.id] = 0; newLevels[ch.id + '_r'] = 0; });
      }

      // Master comes from the real engine.
      const engine = engineRef.current;
      if (engine) {
        engine.readMeters(meterScratchRef.current);
        let peak = 0;
        for (const r of meterScratchRef.current) {
          if (r.channelId === 0 && r.peak > peak) peak = r.peak;
        }
        newLevels['m0'] = peak;
        newLevels['m0_r'] = peak;
      }

      setLevels(newLevels);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, time, channels, engineRef]);
```

Add the `useRef` import at the top of `App.jsx` if not already present (current imports already include `useEffect` / `useState` / `useCallback`; you need to add `useRef`):

```javascript
import { useCallback, useEffect, useRef, useState } from 'react';
```

- [ ] **Step 2: Manual smoke test — meter responds to audio**

Run `npm run dev`, click Play. Observe the master meter in the toolbar (top-right of the UI).

**Expected:**
- The master meter rises immediately when the demo note plays.
- It decays back toward zero when the note's release finishes.
- Stopping playback leaves the meter at 0.

**If the meter stays simulated/full:** confirm the `if (ch.name === 'Master') base = 0;` line is present and that the engine `readMeters` call is wired correctly.

- [ ] **Step 3: Commit**

```bash
git add src/App.jsx
git commit -m "feat: drive master meter from real engine peak"
```

---

### Task 10: Engine-driven transport time

**Files:**
- Modify: `src/App.jsx`

Replace the simulated transport RAF (`App.jsx:36-52`) with a loop that reads the worklet's sample counter and converts to beats.

- [ ] **Step 1: Replace the transport loop**

Locate the first `useEffect` in `App.jsx` (`if (!playing) return;` ... transport simulation). Replace the entire effect with:

```javascript
  const samplesAtPlayStartRef = useRef(0);
  const timeAtPlayStartRef = useRef(0);
  useEffect(() => {
    if (!playing) return;
    const engine = engineRef.current;
    if (!engine) return;
    samplesAtPlayStartRef.current = engine.currentSamplePosition();
    timeAtPlayStartRef.current = time;
    let raf;
    const tick = () => {
      const samples = engine.currentSamplePosition();
      const elapsedSeconds = (samples - samplesAtPlayStartRef.current) / engine.sampleRate;
      const beatsElapsed = elapsedSeconds * (bpm / 60);
      let next = timeAtPlayStartRef.current + beatsElapsed;
      if (loop && next > 32) {
        next = next % 32;
        samplesAtPlayStartRef.current = samples;
        timeAtPlayStartRef.current = next;
      }
      if (next > 128) next = 0;
      setTime(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // bpm/loop changes are intentionally re-captured by the new closure.
  }, [playing, bpm, loop, engineRef]);
```

- [ ] **Step 2: Manual smoke test — playhead advances from engine**

Run `npm run dev`, click Play.

**Expected:**
- The playhead in the playlist advances at real wall-clock rate matching `bpm/60` beats per second (with default 124 BPM, ~2.07 beats/sec).
- Toolbar `BARS · BEATS` and `TIME` displays advance.
- When the loop reaches beat 32, time resets to 0 cleanly with no UI jump.
- Changing BPM via the Toolbar (double-click the TEMPO tile, type a new value) immediately changes how fast the playhead moves.

**If the playhead doesn't move:** confirm `engine.currentSamplePosition()` returns a growing number (use console: `window.__engine = engineRef.current` for a quick debug — though the engine isn't on `window` by default; alternatively `console.log` inside the tick callback).

- [ ] **Step 3: Commit**

```bash
git add src/App.jsx
git commit -m "feat: drive transport time from engine sample counter"
```

---

### Task 11: Final verification + roadmap link

**Files:**
- Modify: `CLAUDE.md` — point to the new engine module and update the "simulated" disclaimer.

- [ ] **Step 1: Run the full test suite**

Run:
```bash
npm test
```

Expected: all tests pass across `RingBuffer`, `EngineEvent`, `SineGenerator` suites.

- [ ] **Step 2: Run typecheck**

Run:
```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Build production bundle**

Run:
```bash
npm run build
```

Expected: builds successfully to `dist/`.

- [ ] **Step 4: End-to-end manual smoke test**

Run `npm run dev`. Open Chrome. Verify, in order:

1. Page loads with no console errors.
2. `crossOriginIsolated` is `true` in console.
3. Click Play → hear a sine note, see master meter rise, see playhead advance.
4. Click Stop → audio stops, playhead returns to 0, master meter returns to 0.
5. Change BPM to 200 → playhead advances faster on next Play.
6. With Loop on (default), let playback reach beat 32 → time wraps to 0 without UI jitter.
7. Tracks view, Mixer view, Browser, Piano Roll all still render correctly (no Phase 1 regression in existing UI).
8. Reload the page → still no errors, engine re-initializes cleanly.

**If any step fails, do NOT proceed. Diagnose and fix; reasons for failure are most commonly:**
- Headers missing → check `vite.config.js`.
- Worklet not registering → check Network tab for `audio-worklet.ts` load and console for errors.
- Meter dead → check the `setTimeout(() => engine.noteOff(60), 800)` is firing; confirm `readMeters` is being called every RAF.

- [ ] **Step 5: Update `CLAUDE.md` Architecture section**

In `CLAUDE.md`, find the line under "Architecture" that reads:

```
Noa Studio is a **mock DAW (FL Studio-style) UI**, fully client-side. There is no audio engine, no backend, no persistence. Everything that looks like playback, metering, or signal flow is simulated for visual fidelity.
```

Replace it with:

```
Noa Studio is a browser-based DAW under active construction. As of Phase 1 (audio foundation), a real `AudioWorkletProcessor`-based engine lives under `src/engine/`. Transport time and the **master** meter are driven by the engine; per-channel mixer meters are still simulated. Plugins, persistence, and multi-track audio routing arrive in later phases — see `docs/superpowers/plans/2026-05-17-noa-daw-roadmap.md`.
```

Then add a new subsection at the bottom of `CLAUDE.md`:

```markdown
### Engine module (`src/engine/`)

TypeScript module, isolated from the JSX UI. Communicates with the React tree via the `useEngine()` hook in `src/engine/useEngine.js`.

- `RingBuffer.ts` — SPSC ring buffer over `SharedArrayBuffer`. Header layout: `[writeIdx, readIdx, capacity, frameSize]` as a `Uint32Array`. Capacity is power-of-2; indices are monotonic and masked on slot lookup.
- `EngineEvent.ts` — 32-byte binary event frames (`NoteOn`, `NoteOff`, `ParamSet`, `Transport`, `Tempo`). `frameOffset` field gives sample-accurate timing within an audio block.
- `dsp/SineGenerator.ts` — Headless 8-voice polyphonic sine generator. Pure DSP, fully unit-testable. Will be deleted in Phase 3 when real plugins arrive.
- `audio-worklet.ts` — `AudioWorkletProcessor` shim. Drains the event ring, runs the generator, publishes per-block meter frames and a sample-counter telemetry SAB.
- `EngineClient.ts` — Main-thread façade. Owns the `AudioContext` + `AudioWorkletNode`. Requires `crossOriginIsolated === true` (enforced by COOP/COEP headers in `vite.config.js`).

Tests live under `src/engine/**/__tests__/*.test.ts` and run via `npm test` (Vitest, Node environment). Anything that touches `AudioContext` is verified by manual browser smoke tests, not unit tests.
```

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for Phase 1 engine module"
```

- [ ] **Step 7: Mark phase complete**

The phase is complete when:
- All steps in this plan are checked.
- All unit tests pass.
- All manual smoke checks in Step 4 pass.
- `git log` shows ~10 commits, one per task.

Phase 2 (SharedWorker app coordinator) can now begin — see the roadmap doc.

---

## Self-review checklist (run after writing the plan, before handing off)

**Spec coverage:**
- Audio path main→worklet → ✓ (Tasks 3, 4, 6, 7, 8).
- Worklet→main meter telemetry → ✓ (Tasks 6, 9).
- COOP/COEP for SAB → ✓ (Task 2).
- Replace simulated transport loop → ✓ (Task 10).
- Replace simulated master meter → ✓ (Task 9).
- TDD coverage where applicable → ✓ (Tasks 3, 4, 5).
- Custom Noa ABI groundwork → ✓ (events + ring buffer protocols are the substrate Phase 3 will build on).

**Type consistency:**
- `EngineEvent` shape: identical between `EngineEvent.ts` test, encoder, `SineGenerator`, worklet, `EngineClient`.
- `MeterReading` shape: defined once in `EngineClient.ts`, consumed in `App.jsx` via `engine.readMeters`.
- Frame sizes: `EVENT_FRAME_SIZE = 32`, `METER_FRAME_SIZE = 16` — used consistently in producer (worklet) and consumer (client).

**Placeholder scan:** none — every code step is concrete and complete.
