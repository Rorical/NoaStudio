import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';

const PR_KEY_H = 14;
const PR_BEAT_W = 56;
const PR_OCTAVES = 4;
const PR_KEYS = PR_OCTAVES * 12;

export default function PianoRoll({ clip, track, color, onClose, onUpdateNotes, onUpdateLength, time }) {
  const [notes, setNotes] = useState(() =>
    (clip?.pattern?.notes || []).map((n, i) => ({
      id: 'n' + i, beat: n[0], pitch: n[1], length: n[2], velocity: 0.8,
    })),
  );
  const [selectedId, setSelectedId] = useState(null);
  const [tool, setTool] = useState('draw');
  const [snap, setSnap] = useState(0.25);
  const [noteLen, setNoteLen] = useState(0.5);

  useEffect(() => {
    setNotes((clip?.pattern?.notes || []).map((n, i) => ({
      id: 'n' + i, beat: n[0], pitch: n[1], length: n[2], velocity: 0.8,
    })));
    setSelectedId(null);
  }, [clip?.id]);

  useEffect(() => {
    if (!clip) return;
    onUpdateNotes?.(clip.id, notes.map((n) => [n.beat, n.pitch, n.length]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);

  const gridWrapRef = useRef(null);
  const [viewportW, setViewportW] = useState(2000);
  useEffect(() => {
    const el = gridWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportW(el.clientWidth));
    ro.observe(el);
    setViewportW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  if (!clip) return null;

  const clipLength = clip.length;
  const maxNoteEnd = notes.reduce((m, n) => Math.max(m, n.beat + n.length), 0);
  const beatsForViewport = Math.ceil(viewportW / PR_BEAT_W);
  const minDisplay = Math.max(clipLength + 8, maxNoteEnd + 8, beatsForViewport);
  const displayBeats = Math.ceil(minDisplay / 4) * 4;
  const gridW = displayBeats * PR_BEAT_W;
  const gridH = PR_KEYS * PR_KEY_H;
  const clipEndX = clipLength * PR_BEAT_W;

  const maybeGrowClip = (endBeat) => {
    if (endBeat > clipLength) {
      const newLen = Math.ceil(endBeat / 4) * 4;
      onUpdateLength?.(clip.id, newLen);
    }
  };

  const rowToPitch = (row) => (PR_KEYS - 1) - row;
  const pitchToRow = (pitch) => (PR_KEYS - 1) - pitch;

  const onGridMouseDown = (e) => {
    if (tool !== 'draw') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const beat = Math.max(0, Math.floor(x / PR_BEAT_W / snap) * snap);
    const row = Math.floor(y / PR_KEY_H);
    if (beat >= displayBeats) return;
    const pitch = rowToPitch(row);
    const id = 'n' + Math.random().toString(36).slice(2, 8);
    setNotes((ns) => [...ns, { id, beat, pitch, length: noteLen, velocity: 0.8 }]);
    setSelectedId(id);
    maybeGrowClip(beat + noteLen);
  };

  const onNoteMouseDown = (e, n) => {
    e.stopPropagation();
    if (tool === 'erase') {
      setNotes((ns) => ns.filter((x) => x.id !== n.id));
      return;
    }
    setSelectedId(n.id);
    const startX = e.clientX, startY = e.clientY;
    const origBeat = n.beat, origPitch = n.pitch;
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const dBeat = Math.round((dx / PR_BEAT_W) / snap) * snap;
      const dRow = Math.round(dy / PR_KEY_H);
      let movedEnd = 0;
      setNotes((ns) =>
        ns.map((x) => {
          if (x.id !== n.id) return x;
          const newBeat = Math.max(0, origBeat + dBeat);
          movedEnd = newBeat + x.length;
          return {
            ...x,
            beat: newBeat,
            pitch: Math.max(0, Math.min(PR_KEYS - 1, origPitch - dRow)),
          };
        }),
      );
      if (movedEnd) maybeGrowClip(movedEnd);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const onKeyDown = (e) => {
    if (selectedId && (e.key === 'Delete' || e.key === 'Backspace')) {
      setNotes((ns) => ns.filter((x) => x.id !== selectedId));
      setSelectedId(null);
    }
  };

  const keys = [];
  for (let r = 0; r < PR_KEYS; r++) {
    const pitch = rowToPitch(r);
    const semitone = pitch % 12;
    const octave = Math.floor(pitch / 12) + 3;
    const isBlack = [1, 3, 6, 8, 10].includes(semitone);
    const isC = semitone === 0;
    const noteName = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][semitone];
    keys.push({ row: r, pitch, isBlack, label: isC ? `${noteName}${octave}` : '', name: `${noteName}${octave}` });
  }

  const inClip = time >= clip.start && time <= clip.start + clip.length;
  const phx = inClip ? (time - clip.start) * PR_BEAT_W : -1;

  return (
    <div className="pianoroll" tabIndex={0} onKeyDown={onKeyDown} style={{ '--track': color }}>
      <div className="pr-head">
        <div className="pr-title">
          <Icon name="piano" size={16} />
          <span className="pr-clip-dot" style={{ background: color }} />
          <span className="pr-clip-name">{clip.label}</span>
          <span className="pr-track-name mono">{track.name} · {track.generator || 'Audio'}</span>
        </div>
        <div className="pr-tools">
          <div className="seg">
            <button className={`seg-btn ${tool === 'draw' ? 'on' : ''}`} onClick={() => setTool('draw')} title="Draw">
              <Icon name="edit" size={14} />
            </button>
            <button className={`seg-btn ${tool === 'select' ? 'on' : ''}`} onClick={() => setTool('select')} title="Select">
              <Icon name="arrows" size={14} />
            </button>
            <button className={`seg-btn ${tool === 'erase' ? 'on' : ''}`} onClick={() => setTool('erase')} title="Erase">
              <Icon name="delete" size={14} />
            </button>
          </div>
          <div className="pr-snap">
            <span className="pr-label">SNAP</span>
            <select value={snap} onChange={(e) => setSnap(parseFloat(e.target.value))} className="pr-select mono">
              <option value="1">1/4</option>
              <option value="0.5">1/8</option>
              <option value="0.25">1/16</option>
              <option value="0.125">1/32</option>
            </select>
          </div>
          <div className="pr-snap">
            <span className="pr-label">LEN</span>
            <select value={noteLen} onChange={(e) => setNoteLen(parseFloat(e.target.value))} className="pr-select mono">
              <option value="2">1/2</option>
              <option value="1">1/4</option>
              <option value="0.5">1/8</option>
              <option value="0.25">1/16</option>
            </select>
          </div>
          <button className="btn-icon small" title="Settings"><Icon name="settings" size={16} /></button>
          <button className="btn-icon small" title="Close" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>
      </div>

      <div className="pr-body">
        <div className="pr-keys" style={{ height: gridH }}>
          {keys.map((k) => (
            <div
              key={k.row}
              className={`pr-key ${k.isBlack ? 'black' : 'white'}`}
              style={{ top: k.row * PR_KEY_H, height: PR_KEY_H }}
            >
              <span className="pr-key-label mono">{k.label}</span>
            </div>
          ))}
        </div>

        <div className="pr-grid-wrap" ref={gridWrapRef}>
          <div className="pr-ruler" style={{ width: gridW }}>
            {Array.from({ length: Math.ceil(displayBeats) }, (_, i) => (
              <div key={i} className="pr-ruler-beat" style={{ left: i * PR_BEAT_W, width: PR_BEAT_W }}>
                <span className="mono">{i + 1}</span>
              </div>
            ))}
          </div>

          <div className="pr-grid" style={{ width: gridW, height: gridH }} onMouseDown={onGridMouseDown}>
            {keys.map((k) => k.isBlack && (
              <div key={k.row} className="pr-row-black" style={{ top: k.row * PR_KEY_H, height: PR_KEY_H, width: gridW }} />
            ))}
            {keys.map((k) => (k.pitch % 12 === 0) && (
              <div key={'c' + k.row} className="pr-row-c" style={{ top: (k.row + 1) * PR_KEY_H }} />
            ))}
            {keys.map((k) => (
              <div key={'h' + k.row} className="pr-row-line" style={{ top: (k.row + 1) * PR_KEY_H }} />
            ))}
            {Array.from({ length: Math.ceil(displayBeats / snap) + 1 }, (_, i) => {
              const beat = i * snap;
              const major = beat % 1 === 0;
              return (
                <div
                  key={i}
                  className={`pr-col ${major ? 'major' : 'minor'}`}
                  style={{ left: beat * PR_BEAT_W, height: gridH }}
                />
              );
            })}

            {clipEndX < gridW && (
              <div className="pr-beyond" style={{ left: clipEndX, width: gridW - clipEndX, height: gridH }} aria-hidden="true" />
            )}
            {clipEndX < gridW && (
              <div className="pr-clip-end" style={{ left: clipEndX, height: gridH }} title={`Clip end · ${clipLength} beats`} />
            )}

            {notes.map((n) => {
              const row = pitchToRow(n.pitch);
              return (
                <div
                  key={n.id}
                  className={`pr-note ${selectedId === n.id ? 'sel' : ''}`}
                  style={{
                    left: n.beat * PR_BEAT_W,
                    top: row * PR_KEY_H + 1,
                    width: n.length * PR_BEAT_W - 2,
                    height: PR_KEY_H - 2,
                  }}
                  onMouseDown={(e) => onNoteMouseDown(e, n)}
                  title={`${keys.find((k) => k.pitch === n.pitch)?.name} · ${n.length} beats`}
                />
              );
            })}

            {phx >= 0 && <div className="pr-playhead" style={{ left: phx, height: gridH }} />}
          </div>
        </div>
      </div>

      <div className="pr-foot">
        <span className="mono">{notes.length} notes · {clipLength} beats · {clipLength / 4} bars</span>
        <span className="pr-hint">
          Click to draw · Drag to move · Notes past clip end extend the clip · {tool === 'erase' ? 'Click note to erase' : 'Backspace to delete'}
        </span>
      </div>
    </div>
  );
}
