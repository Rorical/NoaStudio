import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Toolbar from './components/Toolbar.jsx';
import Browser from './components/Browser.jsx';
import Playlist from './components/Playlist.jsx';
import PianoRoll from './components/PianoRoll.jsx';
import Mixer from './components/Mixer.jsx';
import TweaksPanel from './components/TweaksPanel.jsx';
import PluginWindow from './components/PluginWindow.jsx';
import { TRACK_COLORS, FILES } from './data.js';
import { useEngine } from './engine/useEngine.js';
import { bootBuiltinRegistry } from './engine/bootBuiltins.js';
import { PluginInstaller } from './engine/PluginInstaller.ts';
import { ClipScheduler } from './engine/ClipScheduler.ts';
import { channelHash } from './engine/channelHash.ts';
import { openOpfsPluginStore } from './sw/openOpfsPluginStore.js';
import { useDispatch, useProject, useUndoRedo } from './coordinator/useProject.js';

/**
 * Translate the coordinator's tracks/channels into a worklet RoutingConfig.
 * v1 honours only sends[0]; multi-destination sends arrive in a later phase.
 */
function buildRoutingConfig(tracks, channels) {
  return {
    tracks: tracks
      .filter((t) => t.generator)
      .map((t) => ({
        id: t.id,
        chainId: t.id,
        channelId: 'm' + t.channel,
        mute: !!t.mute,
        solo: !!t.solo,
      })),
    channels: channels.map((c) => ({
      id: c.id,
      fxChainId: c.id,
      vol: c.vol ?? 1,
      pan: c.pan ?? 0,
      mute: !!c.mute,
      solo: !!c.solo,
      sendsTo: (c.sends ?? []).slice(),
    })),
    channelOrder: topoSortChannels(channels),
  };
}

/**
 * Topological order over the channel send graph. Sources first, sinks last —
 * so master (no outgoing sends) processes after every channel that feeds it.
 * Fan-out: a channel can send to several destinations; each contributes one
 * incoming edge to its target.
 */
function topoSortChannels(channels) {
  const ids = channels.map((c) => c.id);
  const idSet = new Set(ids);
  const inDeg = new Map(ids.map((id) => [id, 0]));
  for (const c of channels) {
    for (const dest of c.sends ?? []) {
      if (idSet.has(dest)) inDeg.set(dest, inDeg.get(dest) + 1);
    }
  }
  const order = [];
  const queue = ids.filter((id) => inDeg.get(id) === 0);
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    const c = channels.find((x) => x.id === id);
    for (const dest of c?.sends ?? []) {
      if (!idSet.has(dest)) continue;
      inDeg.set(dest, inDeg.get(dest) - 1);
      if (inDeg.get(dest) === 0) queue.push(dest);
    }
  }
  for (const id of ids) if (!order.includes(id)) order.push(id);
  return order;
}

const selectTracks = (p) => p.tracks;
const selectClips = (p) => p.clips;
const selectChannels = (p) => p.channels;
const selectBpm = (p) => p.bpm;
const selectLoop = (p) => p.loop;
const selectMetronome = (p) => p.metronome;
const selectInstalledPlugins = (p) => p.installedPlugins;

export default function App() {
  const [theme, setTheme] = useState('dark');
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const tracks = useProject(selectTracks);
  const clips = useProject(selectClips);
  const channels = useProject(selectChannels);
  const dispatch = useDispatch();
  const { canUndo, canRedo, undo, redo } = useUndoRedo();
  const [selectedClipId, setSelectedClipId] = useState('c20');
  const [selectedChannelId, setSelectedChannelId] = useState('m6');
  const [openClipId, setOpenClipId] = useState('c20');

  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState(false);
  const bpm = useProject(selectBpm);
  const loop = useProject(selectLoop);
  const metronome = useProject(selectMetronome);
  const installedPlugins = useProject(selectInstalledPlugins);
  const [time, setTime] = useState(0);
  const [levels, setLevels] = useState({});

  const { engineRef, ready: engineReady, error: engineError } = useEngine();

  // instanceId → { paramRingSab, notifyRingSab } — needed to open plugin UIs.
  const instanceRingsRef = useRef(new Map());
  // Compiled plugin registry; ref-only because consumers read it imperatively
  // when opening a window (the catalog state below is what triggers re-renders).
  const registryRef = useRef(null);
  // Bumped once the engine registry boots so the derived `pluginCatalog`
  // memo re-runs with `hasUi` filled in.
  const [registryVersion, setRegistryVersion] = useState(0);

  /**
   * Display catalog: pluginId → { name, kind, tag, hasUi, version }.
   * Sourced from the coordinator's installed plugins (so reinstalls /
   * uninstalls flow through immediately) and enriched with the engine
   * registry's UI info once that boots.
   */
  const pluginCatalog = useMemo(() => {
    const m = new Map();
    for (const p of installedPlugins) {
      m.set(p.pluginId, {
        pluginId: p.pluginId,
        name: p.name,
        kind: p.kind,
        tag: '',
        version: p.version,
        hasUi: false,
      });
    }
    const registry = registryRef.current;
    if (registry) {
      for (const e of registry.list()) {
        const prev = m.get(e.manifest.id);
        if (prev) m.set(e.manifest.id, { ...prev, hasUi: !!e.manifest.ui });
      }
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installedPlugins, registryVersion]);

  const browserPlugins = useMemo(
    () => installedPlugins.map((p) => ({
      pluginId: p.pluginId,
      name: p.name,
      kind: p.kind,
      tag: '',
    })),
    [installedPlugins],
  );
  // UI-ephemeral plugin windows. Each entry: { instanceId, z }. Not persisted.
  const [openWindows, setOpenWindows] = useState([]);
  const nextZRef = useRef(100);

  // Active Service Worker once registration resolves. Null until the SW is
  // installed and activated — PluginWindow falls back to Blob URLs in that
  // interval and on browsers without SW support.
  const [serviceWorker, setServiceWorker] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const reg = await window.__noa?.swReady;
      if (cancelled || !reg) return;
      setServiceWorker(reg.active ?? navigator.serviceWorker.controller ?? null);
    })();
    return () => { cancelled = true; };
  }, []);

  // Plugin installer for the Browser's "Install from URL" flow. Constructed
  // once we have both an OPFS handle and a dispatch reference.
  const [installer, setInstaller] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const store = await openOpfsPluginStore();
        if (cancelled || !store) return;
        setInstaller(new PluginInstaller({
          fetch: window.fetch.bind(window),
          store,
          dispatch,
        }));
      } catch (err) {
        console.warn('[noa] installer init failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [dispatch]);

  const handleInstallFromUrl = useCallback(async (url) => {
    if (!installer) throw new Error('Installer not ready');
    await installer.installFromUrl(url);
  }, [installer]);

  const handleUninstallPlugin = useCallback(async (pluginId) => {
    if (!installer) return;
    try {
      await installer.uninstall(pluginId);
    } catch (err) {
      console.error('[noa] uninstall failed:', err);
    }
  }, [installer]);

  useEffect(() => {
    if (engineReady) engineRef.current?.setTempo(bpm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineReady]);

  // Keep refs to the latest tracks/channels so the boot effect can walk them
  // once at engine-ready without re-running on every coordinator dispatch.
  const tracksRef = useRef(tracks);
  const channelsRef = useRef(channels);
  useEffect(() => { tracksRef.current = tracks; }, [tracks]);
  useEffect(() => { channelsRef.current = channels; }, [channels]);

  // Load the built-in plugin registry once the engine is ready.
  useEffect(() => {
    if (!engineReady) return;
    let cancelled = false;
    (async () => {
      try {
        const registry = await bootBuiltinRegistry();
        if (cancelled) return;
        registryRef.current = registry;
        setRegistryVersion((v) => v + 1);
      } catch (err) {
        console.error('Registry load failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [engineReady]);

  /**
   * Plugin lifecycle diff-sync: every time the coordinator's instance set
   * changes (track generator added/removed, FX inserted/removed/reordered),
   * compute the diff against what's loaded in the engine and call
   * loadPlugin / unloadInstance to reconcile. The seed's instances are loaded
   * on this effect's first run too — there's no separate boot path.
   */
  const loadedInstancesRef = useRef(new Map()); // instanceId → { chainId, slot }
  useEffect(() => {
    if (!engineReady) return;
    const engine = engineRef.current;
    const registry = registryRef.current;
    if (!engine || !registry) return;

    // Build the "wanted" map from coordinator state.
    const wanted = new Map();
    for (const t of tracks) {
      if (t.generator) wanted.set(t.generator.id, { instance: t.generator, chainId: t.id, slot: 0 });
    }
    for (const c of channels) {
      c.effects.forEach((fx, slot) => {
        wanted.set(fx.id, { instance: fx, chainId: c.id, slot });
      });
    }

    // Unload anything the engine has but the coordinator no longer wants —
    // or whose chainId/slot moved (treat as a remove + add).
    const loaded = loadedInstancesRef.current;
    for (const [id, meta] of [...loaded]) {
      const target = wanted.get(id);
      if (!target || target.chainId !== meta.chainId || target.slot !== meta.slot) {
        engine.unloadInstance(id);
        instanceRingsRef.current.delete(id);
        loaded.delete(id);
      }
    }

    // Load anything new. Optimistically mark loaded to dedupe concurrent re-runs.
    let mounted = true;
    for (const [id, target] of wanted) {
      if (loaded.has(id)) continue;
      if (!registry.has(target.instance.pluginId)) continue;
      const entry = registry.get(target.instance.pluginId);
      const initialParams = target.instance.params.length > 0
        ? target.instance.params
        : entry.manifest.params.map((p) => p.default);
      loaded.set(id, { chainId: target.chainId, slot: target.slot });
      engine.loadPlugin({
        instanceId: id,
        chainId: target.chainId,
        slot: target.slot,
        wasm: entry.wasm,
        manifest: entry.manifest,
        initialParams,
      }).then((result) => {
        if (!mounted) return;
        instanceRingsRef.current.set(id, {
          paramRingSab: result.paramRingSab,
          notifyRingSab: result.notifyRingSab,
        });
        // Bump so dependent effects (ClipScheduler.setProject) re-run with
        // the new numericId resolvable.
        setRegistryVersion((v) => v + 1);
      }).catch((err) => {
        console.error(`Plugin ${target.instance.pluginId} (${id}) failed:`, err);
        loaded.delete(id);
      });
    }
    return () => { mounted = false; };
  }, [engineReady, tracks, channels, registryVersion, engineRef]);

  // Re-sync the worklet's routing topology whenever tracks/channels change.
  // Fires after the boot effect because that's when the chains exist;
  // subsequent runs just post UPDATE_ROUTING.
  useEffect(() => {
    if (!engineReady) return;
    const engine = engineRef.current;
    if (!engine) return;
    engine.updateRouting(buildRoutingConfig(tracks, channels));
  }, [engineReady, tracks, channels, engineRef]);

  // ClipScheduler — instantiated once the engine is ready, started/stopped
  // with the transport. Re-syncs its project copy on coordinator changes.
  const [scheduler, setScheduler] = useState(null);
  useEffect(() => {
    if (!engineReady) return;
    const engine = engineRef.current;
    if (!engine) return;
    const sched = new ClipScheduler({
      sampleRate: engine.sampleRate,
      lookaheadSamples: Math.round(engine.sampleRate * 0.05), // 50 ms
      readCurrentSample: () => engine.currentSamplePosition(),
      pushEvent: (frame) => { engine.pushEventFrame(frame); },
    });
    setScheduler(sched);
  }, [engineReady, engineRef]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!scheduler || !engine) return;
    scheduler.setProject({
      bpm,
      tracks: tracks.map((t) => ({
        id: t.id,
        mute: !!t.mute,
        solo: !!t.solo,
        generatorNumericId: t.generator ? engine.getNumericId(t.generator.id) : undefined,
      })),
      clips: clips.map((c) => ({
        trackId: c.trackId,
        start: c.start,
        length: c.length,
        pattern: c.pattern,
      })),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduler, tracks, clips, bpm, registryVersion, engineRef]);

  // Find a PluginInstance by id across tracks + channels. Used by the open
  // plugin windows to pull the current params for HELLO.
  const findInstance = useCallback((instanceId) => {
    for (const t of tracks) if (t.generator?.id === instanceId) return t.generator;
    for (const c of channels) for (const fx of c.effects) if (fx.id === instanceId) return fx;
    return null;
  }, [tracks, channels]);

  const openPluginWindow = useCallback((instanceId) => {
    const z = ++nextZRef.current;
    setOpenWindows((prev) => {
      const existing = prev.find((w) => w.instanceId === instanceId);
      if (existing) return prev.map((w) => (w.instanceId === instanceId ? { ...w, z } : w));
      return [...prev, { instanceId, z }];
    });
  }, []);

  const closePluginWindow = useCallback((instanceId) => {
    setOpenWindows((prev) => prev.filter((w) => w.instanceId !== instanceId));
  }, []);

  const focusPluginWindow = useCallback((instanceId) => {
    const z = ++nextZRef.current;
    setOpenWindows((prev) => prev.map((w) => (w.instanceId === instanceId ? { ...w, z } : w)));
  }, []);

  // ABI v1.1 preset flow: prep on the per-instance worker, activate on the
  // worklet, then free the worker-side handle. The fast activate keeps audio
  // glitch-free; the slow prep is absorbed by the worker.
  const handlePresetRequest = useCallback(async (instanceId, bytes) => {
    const engine = engineRef.current;
    if (!engine) return;
    try {
      const prepared = await engine.preparePreset({ instanceId, bytes });
      engine.activatePreset({ instanceId, preparedStateBytes: prepared.stateBytes });
      engine.freePreset({ instanceId, handle: prepared.handle });
    } catch (err) {
      console.error(`Preset apply failed for ${instanceId}:`, err);
    }
  }, [engineRef]);

  const [view, setView] = useState('tracks');
  const [browserOpen, setBrowserOpen] = useState(true);
  const [pianoOpen, setPianoOpen] = useState(true);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    const onKey = (e) => {
      const cmd = e.ctrlKey || e.metaKey;
      if (!cmd) return;
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // Sync the loop region into the worklet whenever it (or BPM) changes. The
  // worklet pre-computes loopStart/EndSamples on receipt and wraps the
  // playhead sample-accurately each block. v1 loops beats [0, 32).
  useEffect(() => {
    if (!engineReady) return;
    const engine = engineRef.current;
    if (!engine) return;
    engine.setTempo(bpm);
    engine.setLoop({ enabled: loop, startBeats: 0, endBeats: 32 });
  }, [engineReady, bpm, loop, engineRef]);

  useEffect(() => {
    if (!playing) return;
    const engine = engineRef.current;
    if (!engine) return;
    const startSample = engine.currentSamplePosition();

    if (scheduler) scheduler.start({ startSample, startBeat: time });
    let lastBeat = time;
    let lastSample = startSample;

    let raf;
    const tick = () => {
      const beats = engine.playheadBeats();
      const samples = engine.currentSamplePosition();
      // Loop wrap: the worklet snapped its playhead back; reset the scheduler
      // anchor at the new (sample, beat) pair so notes after the wrap re-emit.
      if (beats < lastBeat && scheduler) {
        scheduler.reset({ startSample: samples, startBeat: beats });
      }
      lastBeat = beats;
      lastSample = samples;
      setTime(beats);
      if (scheduler) scheduler.tick();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (scheduler) scheduler.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, engineRef, scheduler]);

  // Map from FNV-1a hash → channel id. Built once per channel-list change so
  // the meter RAF can route incoming frames back to ids without serialising
  // strings through the meter ring.
  const hashToChannelId = useMemo(() => {
    const m = new Map();
    for (const c of channels) m.set(channelHash(c.id), c.id);
    return m;
  }, [channels]);

  const meterScratchRef = useRef([]);
  useEffect(() => {
    let raf;
    const tick = () => {
      const engine = engineRef.current;
      if (!engine) {
        raf = requestAnimationFrame(tick);
        return;
      }
      engine.readMeters(meterScratchRef.current);
      // Fold peaks per channel — multiple frames per RAF for fast playback.
      const peakById = new Map();
      for (const f of meterScratchRef.current) {
        const id = hashToChannelId.get(f.channelHash);
        if (!id) continue;
        const prev = peakById.get(id) ?? 0;
        if (f.peak > prev) peakById.set(id, f.peak);
      }
      // Decay any channel we didn't hear from this tick.
      setLevels((prev) => {
        const next = {};
        for (const c of channels) {
          const fresh = peakById.get(c.id);
          const prior = prev[c.id] ?? 0;
          // Snap up on peak, decay 15% per RAF on silence.
          const v = fresh !== undefined ? Math.max(prior * 0.85, fresh) : prior * 0.85;
          next[c.id] = v;
          next[c.id + '_r'] = v;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [channels, hashToChannelId, engineRef]);

  const masterLevels = [levels['m0'] || 0, levels['m0_r'] || 0];

  const handlePlay = useCallback(async () => {
    const engine = engineRef.current;
    if (engine) await engine.resume();
    setPlaying((prev) => {
      const next = !prev;
      if (engine) {
        if (next) engine.play(time);
        else engine.stop();
      }
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

  const moveClip = useCallback((id, newStart) => {
    dispatch({ type: 'MOVE_CLIP', clipId: id, start: newStart });
  }, [dispatch]);

  const openPianoRoll = useCallback((id) => {
    setOpenClipId(id);
    setSelectedClipId(id);
    setPianoOpen(true);
    setView('tracks');
  }, []);

  // Drops a Browser plugin onto a track's generator slot. `plugin.pluginId` must
  // be a registered manifest id; entries without a pluginId are not droppable.
  const assignGenerator = useCallback((trackId, plugin) => {
    if (!plugin?.pluginId) return;
    dispatch({
      type: 'LOAD_PLUGIN',
      pluginId: plugin.pluginId,
      target: { kind: 'track-generator', trackId },
      defaults: [],
    });
  }, [dispatch]);

  const addEffect = useCallback((channelId, plugin) => {
    if (!plugin?.pluginId) return;
    dispatch({
      type: 'LOAD_PLUGIN',
      pluginId: plugin.pluginId,
      target: { kind: 'channel-fx', channelId },
      defaults: [],
    });
  }, [dispatch]);

  const removeEffect = useCallback((_channelId, instanceId) => {
    dispatch({ type: 'UNLOAD_PLUGIN', instanceId });
  }, [dispatch]);

  const bypassEffect = useCallback((_channelId, instanceId, current) => {
    dispatch({ type: 'SET_INSTANCE_BYPASS', instanceId, bypass: !current });
  }, [dispatch]);

  const setFader = useCallback((id, v) => {
    dispatch({ type: 'SET_FADER', channelId: id, value: v });
  }, [dispatch]);
  const setPan = useCallback((id, v) => {
    dispatch({ type: 'SET_PAN', channelId: id, value: v });
  }, [dispatch]);
  const toggleMute = useCallback((id) => {
    dispatch({ type: 'TOGGLE_CHANNEL_MUTE', channelId: id });
  }, [dispatch]);
  const toggleSolo = useCallback((id) => {
    dispatch({ type: 'TOGGLE_CHANNEL_SOLO', channelId: id });
  }, [dispatch]);

  const toggleTrackMute = useCallback((id) => {
    dispatch({ type: 'TOGGLE_TRACK_MUTE', trackId: id });
  }, [dispatch]);

  const toggleTrackSolo = useCallback((id) => {
    dispatch({ type: 'TOGGLE_TRACK_SOLO', trackId: id });
  }, [dispatch]);

  const updateClipNotes = useCallback((clipId, noteTuples) => {
    dispatch({ type: 'UPDATE_CLIP_NOTES', clipId, notes: noteTuples });
  }, [dispatch]);

  const updateClipLength = useCallback((clipId, newLength) => {
    dispatch({ type: 'UPDATE_CLIP_LENGTH', clipId, length: newLength });
  }, [dispatch]);

  const openClip = clips.find((c) => c.id === openClipId);
  const openClipTrack = openClip ? tracks.find((t) => t.id === openClip.trackId) : null;
  const openClipColor = openClipTrack ? TRACK_COLORS[openClipTrack.color] : '#b8a4ff';

  return (
    <div className={`app theme-${theme}`}>
      <Toolbar
        playing={playing}
        recording={recording}
        loop={loop}
        metronome={metronome}
        bpm={bpm}
        time={time}
        timeSig={[4, 4]}
        projectName="Synthwave Demo.noa"
        masterLevels={masterLevels}
        onPlay={handlePlay}
        onStop={handleStop}
        onRecord={handleRecord}
        onLoop={() => dispatch({ type: 'TOGGLE_LOOP' })}
        onMetronome={() => dispatch({ type: 'TOGGLE_METRONOME' })}
        onBpm={(b) => {
          dispatch({ type: 'SET_BPM', bpm: b });
          engineRef.current?.setTempo(b);
        }}
        view={view}
        onView={setView}
        browserOpen={browserOpen}
        onToggleBrowser={() => setBrowserOpen((o) => !o)}
        pianoOpen={pianoOpen}
        onTogglePiano={() => setPianoOpen((o) => !o)}
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
        onOpenTweaks={() => setTweaksOpen((o) => !o)}
      />

      <main className={`workspace ${browserOpen ? 'with-browser' : 'no-browser'} view-${view}`}>
        {browserOpen && (
          <Browser
            files={FILES}
            plugins={browserPlugins}
            onInstallFromUrl={installer ? handleInstallFromUrl : null}
            onUninstall={installer ? handleUninstallPlugin : null}
          />
        )}

        {view === 'tracks' ? (
          <div className="center-split">
            <Playlist
              tracks={tracks}
              clips={clips}
              selectedClipId={selectedClipId}
              onSelectClip={setSelectedClipId}
              onMoveClip={moveClip}
              onOpenPianoRoll={openPianoRoll}
              time={time}
              playing={playing}
              onSetTime={setTime}
              onAssignGenerator={assignGenerator}
              pluginCatalog={pluginCatalog}
              trackColors={TRACK_COLORS}
              onMuteTrack={toggleTrackMute}
              onSoloTrack={toggleTrackSolo}
            />
            {pianoOpen && openClip && openClipTrack && (
              <PianoRoll
                clip={openClip}
                track={openClipTrack}
                color={openClipColor}
                time={time}
                onClose={() => setPianoOpen(false)}
                onUpdateNotes={updateClipNotes}
                onUpdateLength={updateClipLength}
                pluginCatalog={pluginCatalog}
              />
            )}
          </div>
        ) : (
          <Mixer
            channels={channels}
            levels={levels}
            selectedChannelId={selectedChannelId}
            onSelectChannel={setSelectedChannelId}
            onFader={setFader}
            onPan={setPan}
            onMute={toggleMute}
            onSolo={toggleSolo}
            onAddEffect={addEffect}
            onRemoveEffect={removeEffect}
            onBypassEffect={bypassEffect}
            onOpenEditor={openPluginWindow}
            pluginCatalog={pluginCatalog}
            trackColors={TRACK_COLORS}
            wide
          />
        )}
      </main>

      <footer className="statusbar">
        <span className="status-item">
          <span className="status-dot" style={{ background: playing ? '#5ce2a0' : '#6e6f78' }} />
          {playing ? 'Playing' : 'Stopped'}
        </span>
        <span className="status-divider" />
        <span className="status-item mono">CPU 14% · 48 kHz · 24-bit</span>
        <span className="status-divider" />
        <span className="status-item">Synthwave Demo · {tracks.length} tracks · {clips.length} clips</span>
        <span className="status-spacer" />
        <span className="status-item">Hold ⌥ + drag clip to copy · Double-click MIDI clip to open piano roll</span>
      </footer>

      <TweaksPanel open={tweaksOpen} onClose={() => setTweaksOpen(false)} theme={theme} onTheme={setTheme} />

      {openWindows.map((win) => {
        const inst = findInstance(win.instanceId);
        const registry = registryRef.current;
        const rings = instanceRingsRef.current.get(win.instanceId);
        if (!inst || !registry || !registry.has(inst.pluginId) || !rings) return null;
        const entry = registry.get(inst.pluginId);
        return (
          <PluginWindow
            key={win.instanceId}
            instanceId={win.instanceId}
            manifest={entry.manifest}
            uiAssets={entry.uiAssets}
            initialParams={inst.params}
            paramRingSab={rings.paramRingSab}
            notifyRingSab={rings.notifyRingSab}
            zIndex={win.z}
            onFocus={() => focusPluginWindow(win.instanceId)}
            onClose={() => closePluginWindow(win.instanceId)}
            onPresetRequest={handlePresetRequest}
            serviceWorker={serviceWorker}
          />
        );
      })}
    </div>
  );
}
