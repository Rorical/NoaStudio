# Phase 6c: Dynamic plugin lifecycle — Design Spec

**Predecessors:** Phase 6b shipped: engine-driven transport, multi-destination sends. The audio engine loads the seed's plugin instances once at engine-ready time; subsequent coordinator `LOAD_PLUGIN` / `UNLOAD_PLUGIN` actions update coordinator state and the routing config, but the engine itself never learns about new instances. As a result, drag-from-Browser onto a track header (or a mixer channel) shows up in the UI but produces no audio.

**This phase makes the engine track the coordinator's instance set in real time.** A diff-sync effect compares wanted (= coordinator state) against known (= already loaded in the engine), then loads or unloads accordingly. The boot effect collapses into the same flow: on engine-ready, "known" is empty, so the seed's instances are loaded by the same diff-sync.

---

## 1. End-of-phase demo

1. Open the demo. Hit Play — kick still plays.
2. Drag `Sine` from the Browser onto track `t4` (Bass) header. Coordinator dispatches `LOAD_PLUGIN`; engine receives a `loadPlugin({chainId:'t4', slot:0, ...})`; bass channel starts producing audio.
3. The bass channel meter (`m4`) lights up.
4. Drag `Gain` from the Browser onto the Master channel's FX rack. A second gain inserts at slot 1; master continues to play.
5. Remove an FX with the × button. Engine unloads the instance; the channel still plays through the remaining chain.

---

## 2. Out of scope (deferred)

- **Engine loading from OPFS.** Built-in plugins still load via the Vite-bundled registry. User-installed `.noaplugin`s (Phase 5 install flow) reach OPFS but the engine doesn't fetch from there yet — that wiring is Phase 6d.
- **Per-FX bypass routed through MixerRouter.** `SET_INSTANCE_BYPASS` updates coordinator state; PluginChain doesn't honor it. Deferred.
- **Reordering FX in a rack.** v1 keeps the order they were inserted in. Drag-to-reorder is later.
- **Auto-reseating slot indices on remove.** When an FX in the middle of a rack is removed, downstream slots don't slide down — the engine simply unloads that slot, leaving a gap. The chain skips empty slots already, so audio still flows; the gap is a logical-only blemish.
- **Per-param coordinator → engine push.** UI sliders that emit `SET_PARAM` already update coordinator state; the engine sees param values only via the per-instance param ring (PluginWindow writes directly). Bridging that gap is Phase 6d.

---

## 3. Architecture

### 3.1 Diff-sync effect

```js
const loadedRef = useRef(new Set());   // instanceIds known to the engine

useEffect(() => {
  if (!engineReady || !scheduler) return;
  const engine = engineRef.current;
  const registry = registryRef.current;
  if (!engine || !registry) return;

  // 1. Build the wanted set + chain/slot mapping from coordinator state.
  const wanted = new Map();             // instanceId → { instance, chainId, slot }
  for (const t of tracks) if (t.generator) wanted.set(t.generator.id, { instance: t.generator, chainId: t.id, slot: 0 });
  for (const c of channels) c.effects.forEach((fx, slot) => wanted.set(fx.id, { instance: fx, chainId: c.id, slot }));

  // 2. Unload anything the engine knows about but coordinator no longer wants.
  for (const id of [...loadedRef.current]) {
    if (!wanted.has(id)) {
      engine.unloadInstance(id);
      loadedRef.current.delete(id);
    }
  }

  // 3. Load anything new. Fire-and-forget; on success bump registryVersion so
  //    the ClipScheduler effect re-runs with the new numericId resolvable.
  let mounted = true;
  for (const [id, target] of wanted) {
    if (loadedRef.current.has(id)) continue;
    if (!registry.has(target.instance.pluginId)) continue;
    loadedRef.current.add(id);          // optimistically — prevents a re-issue if the effect re-runs
    const entry = registry.get(target.instance.pluginId);
    const initialParams = target.instance.params.length > 0
      ? target.instance.params
      : entry.manifest.params.map((p) => p.default);
    engine.loadPlugin({
      instanceId: id,
      chainId: target.chainId,
      slot: target.slot,
      wasm: entry.wasm,
      manifest: entry.manifest,
      initialParams,
    }).then(() => {
      if (mounted) setRegistryVersion((v) => v + 1);
    }).catch((err) => {
      loadedRef.current.delete(id);     // rollback so future re-runs retry
      console.error(`load failed: ${id}`, err);
    });
  }
  return () => { mounted = false; };
}, [engineReady, scheduler, tracks, channels, registryVersion]);
```

### 3.2 Boot effect collapses

The current "boot" effect handles registry load + initial plugin loads + initial routing push. We split:

- **Registry effect**: on `engineReady`, load `bootBuiltinRegistry()`, store in `registryRef`, bump `registryVersion`. Done once.
- **Diff-sync effect**: above. Runs every time `tracks`/`channels`/`registryVersion` changes.
- **Routing-sync effect**: unchanged — already pushes routing whenever tracks/channels change.

The diff-sync effect's *first* run is what loads the seed. No special-case bootstrapping needed.

### 3.3 Slot stability

When an FX is removed from a channel's `effects` array, the entries that came *after* it slide down by one in the array. With chain-id = channel id and slot = array-index, the existing slots in the worklet now point at the wrong instances.

Three options:

1. **Stable slot ids.** Assign each instance a `slot` field at creation time; reducer never reshuffles. Removed slots stay holes.
2. **Re-issue every slot on every diff.** Unload all FX in the channel, re-load in new order.
3. **Detect the shift in the diff-sync.** When `loadedRef.current` says "instance i_x is at slot 3" but coordinator now says it's at slot 2, unload-then-reload it.

v1 picks option **3** — the diff includes (chainId, slot) so a slot change is detected as a remove + add.

Concretely the diff-sync's "loaded" set becomes a Map keyed by instanceId with value `{chainId, slot}`. An entry "loaded" with `{chainId:'m0', slot:3}` but "wanted" with `{chainId:'m0', slot:2}` triggers unload+load. Audio glitches on that channel during the re-load, but only when the user explicitly removes an FX (rare).

For Phase 6c, even simpler: don't support removing FX in the middle of a rack. Removing only the last slot. Smoke test verifies.

Actually no — the user can remove any FX. Let me just go with the (id, chainId, slot) tracking and unload+reload on slot mismatch.

---

## 4. Testing

### 4.1 Vitest

No new tests. The diff-sync is App.jsx-level glue; the inner ops (`engine.loadPlugin`, `engine.unloadInstance`) are already exercised in Phase 4 / 6a tests via `WorkletProtocol`.

### 4.2 Playwright smoke

- Open the app, hit Play. Kick still audible (m1 peak > 0).
- Open `__noaDebug.engine.instances`. Confirm exactly 2 entries: `i_sine` (chain 't1') + `i_gain` (chain 'm0') — the seed.
- Programmatically dispatch `LOAD_PLUGIN` for track `t4`. After ~200 ms, `i_<random>` for chain 't4' appears in the engine's instances. m4 meter peaks > 0.
- Dispatch `UNLOAD_PLUGIN` for the new instance. After ~200 ms, `i_<random>` is gone from engine.instances. m4 meter falls to 0.

---

## 5. Risks + open questions

- **Async load races.** Two `LOAD_PLUGIN` actions in quick succession both schedule a `loadPlugin`. The optimistic add to `loadedRef` prevents a duplicate, but the order they actually land in the worklet is whatever Promise resolution order. For v1 that's fine — chains and slots are independent.
- **Engine.unloadInstance vs scheduler.** If the worker's per-instance state is still mid-`preparePreset` when unload fires, the worker's promise rejects. Already handled — EngineClient.unloadInstance terminates the worker, the scheduler doesn't care.
- **Initial registry-not-ready.** During the brief window between engine-ready and `bootBuiltinRegistry()` resolving, the diff-sync runs but does nothing (early return on `!registry`). Once the registry resolves and `registryVersion` bumps, the effect re-runs and loads the seed.
