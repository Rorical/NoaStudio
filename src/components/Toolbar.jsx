import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';

export default function Toolbar({
  playing, onPlay, onStop, onRecord, recording, loop, onLoop,
  metronome, onMetronome, bpm, onBpm, time, timeSig, projectName, masterLevels,
  view, onView, browserOpen, onToggleBrowser, pianoOpen, onTogglePiano,
  onOpenTweaks, onUndo, onRedo, canUndo, canRedo,
}) {
  const [bpmEditing, setBpmEditing] = useState(false);
  const [bpmDraft, setBpmDraft] = useState(String(bpm));

  useEffect(() => setBpmDraft(String(bpm)), [bpm]);

  const formatTime = (beats) => {
    const bar = Math.floor(beats / 4) + 1;
    const beat = Math.floor(beats % 4) + 1;
    const tick = Math.floor((beats % 1) * 96).toString().padStart(2, '0');
    return `${String(bar).padStart(3, '0')}:${beat}:${tick}`;
  };
  const formatClock = (beats) => {
    const sec = (beats / bpm) * 60;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 1000);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  };

  return (
    <header className="toolbar">
      <div className="toolbar-section toolbar-brand">
        <div className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22">
            <defs>
              <linearGradient id="brandG" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#b8a4ff" />
                <stop offset="1" stopColor="#7c5cff" />
              </linearGradient>
            </defs>
            <path d="M4 19V5h2l12 11V5h2v14h-2L6 8v11z" fill="url(#brandG)" />
          </svg>
        </div>
        <div className="brand-text">
          <div className="brand-name">Noa Studio</div>
          <div className="brand-project mono"><Icon name="file" size={11} /> {projectName}</div>
        </div>
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-section transport">
        <button className="btn-icon transport-btn" onClick={onStop} title="Stop">
          <Icon name="stop" size={20} />
        </button>
        <button
          className={`btn-icon transport-btn primary ${playing ? 'playing' : ''}`}
          onClick={onPlay}
          title={playing ? 'Pause' : 'Play'}
        >
          <Icon name={playing ? 'pause' : 'play'} size={26} />
        </button>
        <button
          className={`btn-icon transport-btn ${recording ? 'recording' : ''}`}
          onClick={onRecord}
          title="Record"
        >
          <Icon name="record" size={18} />
        </button>
        <button
          className={`btn-icon transport-btn small ${loop ? 'active' : ''}`}
          onClick={onLoop}
          title="Loop"
        >
          <Icon name="loop" size={18} />
        </button>
        <button
          className={`btn-icon transport-btn small ${metronome ? 'active' : ''}`}
          onClick={onMetronome}
          title="Metronome"
        >
          <Icon name="metronome" size={18} />
        </button>
      </div>

      <div className="toolbar-section position">
        <div className="position-block">
          <div className="position-label">BARS · BEATS</div>
          <div className="position-value mono">{formatTime(time)}</div>
        </div>
        <div className="position-block">
          <div className="position-label">TIME</div>
          <div className="position-value mono">{formatClock(time)}</div>
        </div>
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-section meta">
        <div className="meta-tile" title="Tempo (BPM)" onDoubleClick={() => setBpmEditing(true)}>
          <div className="meta-label">TEMPO</div>
          {bpmEditing ? (
            <input
              className="meta-input mono"
              autoFocus
              value={bpmDraft}
              onChange={(e) => setBpmDraft(e.target.value)}
              onBlur={() => {
                const n = parseFloat(bpmDraft);
                if (!isNaN(n) && n >= 30 && n <= 300) onBpm(n);
                setBpmEditing(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') { setBpmDraft(String(bpm)); setBpmEditing(false); }
              }}
            />
          ) : (
            <div className="meta-value mono">{bpm.toFixed(2)}</div>
          )}
        </div>
        <div className="meta-tile" title="Time signature">
          <div className="meta-label">METER</div>
          <div className="meta-value mono">{timeSig[0]}/{timeSig[1]}</div>
        </div>
        <div className="meta-tile" title="Key">
          <div className="meta-label">KEY</div>
          <div className="meta-value mono">C min</div>
        </div>
      </div>

      <div className="toolbar-spacer">
        <div className="view-tabs">
          <button className={`view-tab ${view === 'tracks' ? 'on' : ''}`} onClick={() => onView('tracks')}>
            <Icon name="bus" size={16} /> Tracks
          </button>
          <button className={`view-tab ${view === 'mixer' ? 'on' : ''}`} onClick={() => onView('mixer')}>
            <Icon name="fader" size={16} /> Mixer
          </button>
        </div>
      </div>

      <div className="toolbar-section master">
        <div className="master-meter" aria-hidden="true">
          <div className="meter-channel">
            <div className="meter-bar" style={{ height: `${masterLevels[0] * 100}%` }} />
          </div>
          <div className="meter-channel">
            <div className="meter-bar" style={{ height: `${masterLevels[1] * 100}%` }} />
          </div>
        </div>
        <div className="master-label">
          <div className="meta-label">MASTER</div>
          <div className="master-db mono">
            -{Math.max(0, Math.min(99, (1 - Math.max(...masterLevels)) * 40)).toFixed(1)} dB
          </div>
        </div>
      </div>

      <div className="toolbar-section actions">
        <button
          className={`btn-icon small panel-toggle ${browserOpen ? 'on' : ''}`}
          onClick={onToggleBrowser}
          title="Toggle browser"
        >
          <Icon name="panel_left" size={18} />
        </button>
        <button
          className={`btn-icon small panel-toggle ${pianoOpen ? 'on' : ''} ${view !== 'tracks' ? 'disabled' : ''}`}
          onClick={onTogglePiano}
          disabled={view !== 'tracks'}
          title="Toggle piano roll"
        >
          <Icon name="panel_bottom" size={18} />
        </button>
        <div className="actions-divider" />
        <button
          className="btn-icon small"
          title="Undo (Ctrl+Z)"
          onClick={onUndo}
          disabled={!canUndo}
        >
          <Icon name="undo" size={18} />
        </button>
        <button
          className="btn-icon small"
          title="Redo (Ctrl+Shift+Z)"
          onClick={onRedo}
          disabled={!canRedo}
        >
          <Icon name="redo" size={18} />
        </button>
        <button className="btn-icon small" title="Save"><Icon name="save" size={18} /></button>
        <button className="btn-icon small" title="Settings" onClick={onOpenTweaks}><Icon name="settings" size={18} /></button>
      </div>
    </header>
  );
}
