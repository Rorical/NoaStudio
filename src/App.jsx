import { useCallback, useEffect, useRef, useState } from 'react';
import Toolbar from './components/Toolbar.jsx';
import Browser from './components/Browser.jsx';
import Playlist from './components/Playlist.jsx';
import PianoRoll from './components/PianoRoll.jsx';
import Mixer from './components/Mixer.jsx';
import TweaksPanel from './components/TweaksPanel.jsx';
import PluginWindow from './components/PluginWindow.jsx';
import { TRACK_COLORS, PLUGINS, FILES } from './data.js';
import { useEngine } from './engine/useEngine.js';
import { bootBuiltinRegistry } from './engine/bootBuiltins.js';
import { useDispatch, useProject, useUndoRedo } from './coordinator/useProject.js';

// Drag-source catalog for the Browser pane. Keyed by pluginId.
const DRAG_CATALOG = new Map(
  PLUGINS.filter((p) => p.pluginId).map((p) => [p.pluginId, p]),
);

const selectTracks = (p) => p.tracks;
const selectClips = (p) => p.clips;
const selectChannels = (p) => p.channels;
const selectBpm = (p) => p.bpm;
const selectLoop = (p) => p.loop;
const selectMetronome = (p) => p.metronome;

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
  const [time, setTime] = useState(0);
  const [levels, setLevels] = useState({});

  const { engineRef, ready: engineReady, error: engineError } = useEngine();

  // instanceId → slot in the worklet chain. Populated by the boot effect below.
  const slotMapRef = useRef(new Map());
  // instanceId → { paramRingSab, notifyRingSab } — needed to open plugin UIs.
  const instanceRingsRef = useRef(new Map());
  // Compiled plugin registry; ref-only because consumers read it imperatively
  // when opening a window (the catalog state below is what triggers re-renders).
  const registryRef = useRef(null);
  // Display catalog: pluginId → { name, kind, tag, hasUi }. Starts with the
  // Browser's drag entries, gets enriched once the engine boot loads each
  // plugin's manifest (which is when hasUi becomes known).
  const [pluginCatalog, setPluginCatalog] = useState(DRAG_CATALOG);
  // UI-ephemeral plugin windows. Each entry: { instanceId, z }. Not persisted.
  const [openWindows, setOpenWindows] = useState([]);
  const nextZRef = useRef(100);

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

  // Boot the plugin chain once the engine is ready: load each instance in the
  // coordinator project state, in slot order (track generators first, then
  // channel FX racks in channel order).
  useEffect(() => {
    if (!engineReady) return;
    let cancelled = false;
    (async () => {
      const engine = engineRef.current;
      if (!engine) return;
      try {
        const registry = await bootBuiltinRegistry();
        if (cancelled) return;
        registryRef.current = registry;

        // Build the runtime plugin catalog from the registry (enriches the
        // static drag-source entries with kind + hasUi info).
        const catalog = new Map(DRAG_CATALOG);
        for (const entry of registry.list()) {
          const prev = catalog.get(entry.manifest.id) ?? {};
          catalog.set(entry.manifest.id, {
            ...prev,
            name: entry.manifest.name,
            kind: entry.manifest.kind,
            tag: prev.tag ?? '',
            hasUi: !!entry.manifest.ui,
          });
        }
        if (!cancelled) setPluginCatalog(catalog);

        const map = new Map();
        const rings = new Map();
        let nextSlot = 0;

        const loadOne = async (instance) => {
          if (!registry.has(instance.pluginId)) return;
          const entry = registry.get(instance.pluginId);
          const initialParams = instance.params.length > 0
            ? instance.params
            : entry.manifest.params.map((p) => p.default);
          const slot = nextSlot++;
          const result = await engine.loadPlugin({
            instanceId: instance.id,
            slot,
            module: entry.module,
            manifest: entry.manifest,
            initialParams,
          });
          map.set(instance.id, slot);
          rings.set(instance.id, {
            paramRingSab: result.paramRingSab,
            notifyRingSab: result.notifyRingSab,
          });
        };

        for (const track of tracksRef.current) {
          if (cancelled) return;
          if (track.generator) await loadOne(track.generator);
        }
        for (const channel of channelsRef.current) {
          for (const fx of channel.effects) {
            if (cancelled) return;
            await loadOne(fx);
          }
        }
        slotMapRef.current = map;
        instanceRingsRef.current = rings;
      } catch (err) {
        console.error('Plugin boot failed:', err);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineReady]);

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
      const elapsedSeconds = ((samples - samplesAtPlayStartRef.current) >>> 0) / engine.sampleRate;
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

  const masterLevels = [levels['m0'] || 0, levels['m0_r'] || 0];

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
        {browserOpen && <Browser files={FILES} plugins={PLUGINS} />}

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
          />
        );
      })}
    </div>
  );
}
