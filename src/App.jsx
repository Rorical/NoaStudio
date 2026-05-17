import { useCallback, useEffect, useState } from 'react';
import Toolbar from './components/Toolbar.jsx';
import Browser from './components/Browser.jsx';
import Playlist from './components/Playlist.jsx';
import PianoRoll from './components/PianoRoll.jsx';
import Mixer from './components/Mixer.jsx';
import TweaksPanel from './components/TweaksPanel.jsx';
import { TRACK_COLORS, DEMO_TRACKS, DEMO_CLIPS, DEMO_CHANNELS, PLUGINS, FILES } from './data.js';

export default function App() {
  const [theme, setTheme] = useState('dark');
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [tracks, setTracks] = useState(DEMO_TRACKS);
  const [clips, setClips] = useState(DEMO_CLIPS);
  const [channels, setChannels] = useState(DEMO_CHANNELS);
  const [selectedClipId, setSelectedClipId] = useState('c20');
  const [selectedChannelId, setSelectedChannelId] = useState('m6');
  const [openClipId, setOpenClipId] = useState('c20');

  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState(false);
  const [loop, setLoop] = useState(true);
  const [metronome, setMetronome] = useState(false);
  const [bpm, setBpm] = useState(124);
  const [time, setTime] = useState(0);
  const [levels, setLevels] = useState({});

  const [view, setView] = useState('tracks');
  const [browserOpen, setBrowserOpen] = useState(true);
  const [pianoOpen, setPianoOpen] = useState(true);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    if (!playing) return;
    let raf, last = performance.now();
    const tick = (now) => {
      const dt = (now - last) / 1000;
      last = now;
      setTime((t) => {
        const next = t + (bpm / 60) * dt;
        if (loop && next > 32) return 0;
        if (next > 128) return 0;
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, bpm, loop]);

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
          if (ch.name === 'Master') base = 0.45 + Math.abs(Math.sin(beat * 2)) * 0.4;
          newLevels[ch.id] = Math.max(0, Math.min(1, base));
          newLevels[ch.id + '_r'] = Math.max(0, Math.min(1, base * (0.85 + Math.sin(t * 4 + ch.vol) * 0.1)));
        });
      } else {
        channels.forEach((ch) => { newLevels[ch.id] = 0; newLevels[ch.id + '_r'] = 0; });
      }
      setLevels(newLevels);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, time, channels]);

  const masterLevels = [levels['m0'] || 0, levels['m0_r'] || 0];

  const handlePlay = useCallback(() => setPlaying((p) => !p), []);
  const handleStop = useCallback(() => { setPlaying(false); setTime(0); }, []);
  const handleRecord = useCallback(() => { setRecording((r) => !r); setPlaying((p) => (!p ? true : p)); }, []);

  const moveClip = useCallback((id, newStart) => {
    setClips((cs) => cs.map((c) => (c.id === id ? { ...c, start: newStart } : c)));
  }, []);

  const openPianoRoll = useCallback((id) => {
    setOpenClipId(id);
    setSelectedClipId(id);
    setPianoOpen(true);
    setView('tracks');
  }, []);

  const assignGenerator = useCallback((trackId, name) => {
    setTracks((ts) => ts.map((t) => (t.id === trackId ? { ...t, generator: name, type: 'midi' } : t)));
  }, []);

  const addEffect = useCallback((channelId, plugin) => {
    setChannels((cs) =>
      cs.map((c) =>
        c.id === channelId
          ? {
              ...c,
              effects: [
                ...c.effects,
                { id: 'e' + Math.random().toString(36).slice(2, 6), name: plugin.name, kind: 'fx', bypass: false },
              ],
            }
          : c,
      ),
    );
  }, []);

  const removeEffect = useCallback((channelId, fxId) => {
    setChannels((cs) =>
      cs.map((c) => (c.id === channelId ? { ...c, effects: c.effects.filter((e) => e.id !== fxId) } : c)),
    );
  }, []);

  const bypassEffect = useCallback((channelId, fxId) => {
    setChannels((cs) =>
      cs.map((c) =>
        c.id === channelId
          ? { ...c, effects: c.effects.map((e) => (e.id === fxId ? { ...e, bypass: !e.bypass } : e)) }
          : c,
      ),
    );
  }, []);

  const setFader = useCallback((id, v) => {
    setChannels((cs) => cs.map((c) => (c.id === id ? { ...c, vol: v } : c)));
  }, []);
  const setPan = useCallback((id, v) => {
    setChannels((cs) => cs.map((c) => (c.id === id ? { ...c, pan: v } : c)));
  }, []);
  const toggleMute = useCallback((id) => {
    setChannels((cs) => cs.map((c) => (c.id === id ? { ...c, mute: !c.mute } : c)));
  }, []);
  const toggleSolo = useCallback((id) => {
    setChannels((cs) => cs.map((c) => (c.id === id ? { ...c, solo: !c.solo } : c)));
  }, []);

  const toggleTrackMute = useCallback((id) => {
    setTracks((ts) => ts.map((t) => (t.id === id ? { ...t, mute: !t.mute } : t)));
    const tr = tracks.find((t) => t.id === id);
    if (tr) toggleMute('m' + tr.channel);
  }, [tracks, toggleMute]);

  const toggleTrackSolo = useCallback((id) => {
    setTracks((ts) => ts.map((t) => (t.id === id ? { ...t, solo: !t.solo } : t)));
    const tr = tracks.find((t) => t.id === id);
    if (tr) toggleSolo('m' + tr.channel);
  }, [tracks, toggleSolo]);

  const updateClipNotes = useCallback((clipId, noteTuples) => {
    setClips((cs) => cs.map((c) => (c.id === clipId ? { ...c, pattern: { notes: noteTuples } } : c)));
  }, []);

  const updateClipLength = useCallback((clipId, newLength) => {
    setClips((cs) => cs.map((c) => (c.id === clipId && newLength > c.length ? { ...c, length: newLength } : c)));
  }, []);

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
        onLoop={() => setLoop((l) => !l)}
        onMetronome={() => setMetronome((m) => !m)}
        onBpm={setBpm}
        view={view}
        onView={setView}
        browserOpen={browserOpen}
        onToggleBrowser={() => setBrowserOpen((o) => !o)}
        pianoOpen={pianoOpen}
        onTogglePiano={() => setPianoOpen((o) => !o)}
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
    </div>
  );
}
