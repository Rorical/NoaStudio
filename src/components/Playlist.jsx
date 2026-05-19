import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';

export const BEAT_PX = 26;
export const BAR_BEATS = 4;
export const TOTAL_BEATS = 32 * BAR_BEATS;
const TRACK_H = 56;

export default function Playlist({
  tracks, clips, selectedClipId, onSelectClip, onMoveClip, onResizeClip, onDuplicateClip, onOpenPianoRoll,
  time, playing, onSetTime, onAssignGenerator, onAddTrackEffect,
  onRemoveTrackEffect, onReorderTrackEffect,
  selectedTrackId, onSelectTrack, snapBeats = 0.25,
  pluginCatalog, trackColors, onSoloTrack, onMuteTrack,
}) {
  const lookup = (pluginId) => pluginCatalog?.get?.(pluginId);
  const scrollRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const [hoverTrack, setHoverTrack] = useState(null);
  /** Which track's FX list is open (one at a time, or null). */
  const [fxOpenTrackId, setFxOpenTrackId] = useState(null);
  const playheadX = time * BEAT_PX;

  useEffect(() => {
    if (!playing || !scrollRef.current) return;
    const el = scrollRef.current;
    const localX = playheadX - el.scrollLeft;
    if (localX > el.clientWidth - 120) el.scrollLeft = playheadX - el.clientWidth + 200;
    if (localX < 0) el.scrollLeft = Math.max(0, playheadX - 80);
  }, [playheadX, playing]);

  const onClipMouseDown = (e, clip) => {
    e.stopPropagation();
    onSelectClip(clip.id);
    if (e.altKey) {
      // Alt-click: clone the clip in place. Original stays selected; the
      // duplicate appears at start+length and the user can drag it from there.
      onDuplicateClip?.(clip.id);
      return;
    }
    setDrag({ kind: 'move', id: clip.id, startX: e.clientX, orig: clip.start, last: 0 });
  };

  const onClipResizeMouseDown = (e, clip) => {
    e.stopPropagation();
    e.preventDefault();
    onSelectClip(clip.id);
    setDrag({ kind: 'resize', id: clip.id, startX: e.clientX, orig: clip.length, last: clip.length });
  };

  useEffect(() => {
    if (!drag) return;
    const handleMove = (e) => {
      const dx = e.clientX - drag.startX;
      const rawBeats = dx / BEAT_PX;
      // snapBeats=0 means continuous; positive value quantizes to that grid.
      const deltaBeats = snapBeats > 0
        ? Math.round(rawBeats / snapBeats) * snapBeats
        : rawBeats;
      if (drag.kind === 'move') {
        const newStart = Math.max(0, drag.orig + deltaBeats);
        if (newStart !== drag.last) {
          onMoveClip(drag.id, newStart);
          setDrag((d) => ({ ...d, last: newStart }));
        }
      } else if (drag.kind === 'resize') {
        const newLength = Math.max(0.25, drag.orig + deltaBeats);
        if (newLength !== drag.last) {
          onResizeClip?.(drag.id, newLength);
          setDrag((d) => ({ ...d, last: newLength }));
        }
      }
    };
    const handleUp = () => setDrag(null);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [drag, onMoveClip, onResizeClip, snapBeats]);

  const onRulerClick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left + scrollRef.current.scrollLeft;
    onSetTime(Math.max(0, x / BEAT_PX));
  };

  const onTrackDrop = (e, track) => {
    e.preventDefault();
    const plugin = e.dataTransfer.getData('plugin');
    if (plugin) {
      const p = JSON.parse(plugin);
      // Hold Shift to insert as a track FX (post-generator, pre-channel).
      // Otherwise drop a generator into the track's generator slot.
      if (e.shiftKey && p.kind === 'fx') {
        onAddTrackEffect?.(track.id, p);
      } else if (p.kind === 'gen') {
        onAssignGenerator(track.id, p);
      } else if (p.kind === 'fx') {
        // Convenience: drop an FX without Shift also adds as a track FX.
        onAddTrackEffect?.(track.id, p);
      }
    }
    setHoverTrack(null);
  };

  return (
    <section className="playlist">
      <div className="playlist-head">
        <div className="playlist-title">
          <Icon name="bus" size={16} /> Tracks
        </div>
        <div className="playlist-tools">
          <button className="btn-icon tiny" title="Add track"><Icon name="add" size={16} /></button>
          <span className="mono playlist-zoom">100%</span>
          <button className="btn-icon tiny" title="More"><Icon name="more_h" size={14} /></button>
        </div>
      </div>

      <div className="playlist-grid">
        <div className="track-headers">
          <div className="track-headers-spacer" />
          {tracks.map((t, i) => (
            <div
              key={t.id}
              className={`track-header track-color-${t.color} ${hoverTrack === t.id ? 'drop' : ''} ${selectedTrackId === t.id ? 'selected' : ''}`}
              style={{ '--track': trackColors[t.color], height: TRACK_H }}
              onClick={() => onSelectTrack?.(t.id)}
              onDragOver={(e) => { e.preventDefault(); setHoverTrack(t.id); }}
              onDragLeave={() => setHoverTrack(null)}
              onDrop={(e) => onTrackDrop(e, t)}
            >
              <div className="track-color-bar" />
              <div className="track-num mono">{String(i + 1).padStart(2, '0')}</div>
              <div className="track-info">
                <div className="track-name">{t.name}</div>
                <div className="track-gen">
                  <Icon name={t.type === 'midi' ? 'synth' : 'audio'} size={11} />
                  <span className="track-gen-name">
                    {t.generator
                      ? (lookup(t.generator.pluginId)?.name ?? t.generator.pluginId)
                      : (t.type === 'audio' ? 'Audio in' : 'No plugin')}
                  </span>
                  {t.effects && t.effects.length > 0 && (
                    <button
                      className={`track-fx-count mono ${fxOpenTrackId === t.id ? 'open' : ''}`}
                      title={`${t.effects.length} track FX — click to manage`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setFxOpenTrackId((id) => id === t.id ? null : t.id);
                      }}
                    >
                      <Icon name="tune" size={10} /> {t.effects.length}
                    </button>
                  )}
                </div>
              </div>
              <div className="track-ctrls">
                <button className={`tlet mute ${t.mute ? 'on' : ''}`} title="Mute" onClick={() => onMuteTrack(t.id)}>M</button>
                <button className={`tlet solo ${t.solo ? 'on' : ''}`} title="Solo" onClick={() => onSoloTrack(t.id)}>S</button>
                <div className="track-channel mono" title="Mixer channel">{String(t.channel).padStart(2, '0')}</div>
              </div>
              {fxOpenTrackId === t.id && t.effects && t.effects.length > 0 && (
                <div className="track-fx-list">
                  {t.effects.map((fx, i) => (
                    <div key={fx.id} className="track-fx-row">
                      <span className="track-fx-name">
                        {lookup(fx.pluginId)?.name ?? fx.pluginId}
                      </span>
                      <button
                        className="btn-icon tiny"
                        title="Move up"
                        disabled={i === 0}
                        onClick={() => onReorderTrackEffect?.(t.id, i, i - 1)}
                      ><Icon name="chevron_u" size={12} /></button>
                      <button
                        className="btn-icon tiny"
                        title="Move down"
                        disabled={i === t.effects.length - 1}
                        onClick={() => onReorderTrackEffect?.(t.id, i, i + 1)}
                      ><Icon name="chevron_d" size={12} /></button>
                      <button
                        className="btn-icon tiny"
                        title="Remove"
                        onClick={() => onRemoveTrackEffect?.(fx.id)}
                      ><Icon name="close" size={12} /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="timeline-wrap" ref={scrollRef}>
          <div className="timeline" style={{ width: TOTAL_BEATS * BEAT_PX }}>
            <div className="ruler" onClick={onRulerClick}>
              {Array.from({ length: 32 }, (_, i) => (
                <div
                  key={i}
                  className="ruler-bar"
                  style={{ left: i * BAR_BEATS * BEAT_PX, width: BAR_BEATS * BEAT_PX }}
                >
                  <span className="mono">{i + 1}</span>
                </div>
              ))}
            </div>

            <div className="timeline-body">
              <div className="grid-lines">
                {Array.from({ length: 32 * BAR_BEATS }, (_, i) => (
                  <div
                    key={i}
                    className={`grid-line ${i % BAR_BEATS === 0 ? 'bar' : ''}`}
                    style={{ left: i * BEAT_PX }}
                  />
                ))}
              </div>

              {tracks.map((t, ti) => (
                <div
                  key={t.id}
                  className={`track-row ${ti % 2 === 0 ? 'even' : 'odd'}`}
                  style={{ height: TRACK_H, top: ti * TRACK_H }}
                />
              ))}

              {clips.map((clip) => {
                const ti = tracks.findIndex((t) => t.id === clip.trackId);
                if (ti < 0) return null;
                const t = tracks[ti];
                const isSel = clip.id === selectedClipId;
                return (
                  <ClipView
                    key={clip.id}
                    clip={clip}
                    track={t}
                    color={trackColors[t.color]}
                    top={ti * TRACK_H + 3}
                    height={TRACK_H - 6}
                    selected={isSel}
                    onMouseDown={(e) => onClipMouseDown(e, clip)}
                    onResizeMouseDown={(e) => onClipResizeMouseDown(e, clip)}
                    onDoubleClick={() => clip.pattern && onOpenPianoRoll(clip.id)}
                  />
                );
              })}

              <div className="playhead" style={{ left: playheadX, height: tracks.length * TRACK_H }}>
                <div className="playhead-tri" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ClipView({ clip, color, top, height, selected, onMouseDown, onResizeMouseDown, onDoubleClick }) {
  const w = clip.length * BEAT_PX;
  const x = clip.start * BEAT_PX;

  return (
    <div
      className={`clip ${selected ? 'selected' : ''} ${clip.audio ? 'audio' : 'midi'}`}
      style={{ '--track': color, left: x, top, width: w, height }}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      title={clip.label}
    >
      <div className="clip-head">
        <span className="clip-name">{clip.label}</span>
      </div>
      <div className="clip-body">
        {clip.audio
          ? <ClipWaveform width={w} height={height - 16} />
          : <ClipMidiPreview pattern={clip.pattern} length={clip.length} width={w} height={height - 16} />}
      </div>
      <div
        className="clip-resize"
        onMouseDown={onResizeMouseDown}
        title="Drag to resize"
      />
    </div>
  );
}

function ClipMidiPreview({ pattern, length, width, height }) {
  if (!pattern || !pattern.notes) return null;
  const pad = 4;
  const notes = pattern.notes;
  let minP = 24, maxP = 0;
  notes.forEach(([, p]) => { if (p < minP) minP = p; if (p > maxP) maxP = p; });
  const range = Math.max(1, maxP - minP);
  return (
    <svg className="clip-midi" width={width} height={height}>
      {notes.map(([beat, pitch, len], i) => {
        const beatMod = beat % length;
        const x = (beatMod / length) * width;
        const w = Math.max(2, (len / length) * width);
        const y = pad + ((maxP - pitch) / range) * (height - pad * 2 - 3);
        return <rect key={i} x={x} y={y} width={w} height={2.5} rx={1.25} fill="currentColor" opacity="0.85" />;
      })}
    </svg>
  );
}

function ClipWaveform({ width, height }) {
  const points = [];
  const N = Math.max(20, Math.floor(width / 3));
  for (let i = 0; i < N; i++) {
    const t = i / N;
    const a = Math.sin(t * 12) * 0.4 + Math.sin(t * 31) * 0.3 + Math.sin(t * 7 + 1.2) * 0.3;
    points.push(Math.abs(a) * height / 2 * 0.9 + 1);
  }
  const mid = height / 2;
  return (
    <svg className="clip-wave" width={width} height={height}>
      <path
        d={
          `M0 ${mid} ` +
          points.map((p, i) => `L${(i / N) * width} ${mid - p}`).join(' ') +
          ` L${width} ${mid} ` +
          points.map((p, i) => `L${((N - 1 - i) / N) * width} ${mid + p}`).join(' ') +
          ' Z'
        }
        fill="currentColor"
        opacity="0.78"
      />
    </svg>
  );
}
