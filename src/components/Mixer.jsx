import { useState } from 'react';
import Icon from './Icon.jsx';

export default function Mixer({
  channels, levels, selectedChannelId, onSelectChannel,
  onFader, onPan, onMute, onSolo, onAddEffect, onRemoveEffect, onBypassEffect,
  onReorderEffect, onSetSendLevel, onOpenEditor, pluginCatalog, trackColors, wide,
}) {
  // pluginCatalog: Map<pluginId, { name: string, kind: 'gen' | 'fx', tag?: string }>
  const lookup = (pluginId) => pluginCatalog?.get?.(pluginId);

  const onChannelDrop = (e, ch) => {
    e.preventDefault();
    const plugin = e.dataTransfer.getData('plugin');
    if (plugin) {
      const p = JSON.parse(plugin);
      if (p.kind === 'fx') onAddEffect(ch.id, p);
    }
  };
  const onFxPanelDrop = (e, ch) => {
    e.preventDefault();
    const plugin = e.dataTransfer.getData('plugin');
    if (plugin) {
      const p = JSON.parse(plugin);
      if (p.kind === 'fx') onAddEffect(ch.id, p);
    }
  };

  const selectedChannel = channels.find((c) => c.id === selectedChannelId) || channels[0];
  const selectedColor = selectedChannel.color != null
    ? trackColors[selectedChannel.color]
    : (selectedChannel.id === 'm0' ? '#b8a4ff' : '#9a9ba5');

  return (
    <section className={`mixer ${wide ? 'wide' : ''}`}>
      <div className="mixer-head">
        <div className="mixer-title"><Icon name="fader" size={16} /> Mixer</div>
        <div className="mixer-tools">
          <button className="btn-icon tiny" title="Add channel"><Icon name="add" size={14} /></button>
          <button className="btn-icon tiny" title="More"><Icon name="more_h" size={14} /></button>
        </div>
      </div>

      <div className="mixer-body">
        <div className="mixer-strips">
          {channels.map((ch) => {
            const isMaster = ch.id === 'm0';
            const isBus = ch.id.startsWith('mB') || ch.id.startsWith('mR');
            const color = ch.color != null ? trackColors[ch.color] : (isMaster ? '#b8a4ff' : '#9a9ba5');
            return (
              <ChannelStrip
                key={ch.id}
                channel={ch}
                color={color}
                level={levels[ch.id] || 0}
                level2={levels[ch.id + '_r'] || 0}
                selected={selectedChannelId === ch.id}
                isMaster={isMaster}
                isBus={isBus}
                fxCount={ch.effects.length}
                onSelect={() => onSelectChannel(ch.id)}
                onFader={(v) => onFader(ch.id, v)}
                onPan={(v) => onPan(ch.id, v)}
                onMute={() => onMute(ch.id)}
                onSolo={() => onSolo(ch.id)}
                onDrop={(e) => onChannelDrop(e, ch)}
              />
            );
          })}
        </div>

        <FxPanel
          channel={selectedChannel}
          color={selectedColor}
          lookup={lookup}
          onRemoveEffect={(iid) => onRemoveEffect(selectedChannel.id, iid)}
          onBypassEffect={(iid, current) => onBypassEffect(selectedChannel.id, iid, current)}
          onReorderEffect={onReorderEffect}
          onSetSendLevel={onSetSendLevel}
          onOpenEditor={onOpenEditor}
          onDrop={(e) => onFxPanelDrop(e, selectedChannel)}
        />
      </div>
    </section>
  );
}

function ChannelStrip({ channel, color, level, level2, selected, isMaster, isBus, fxCount, onSelect, onFader, onPan, onMute, onSolo, onDrop }) {
  const [faderDrag, setFaderDrag] = useState(false);
  const [dropHover, setDropHover] = useState(false);

  const onFaderMouseDown = (e) => {
    e.preventDefault();
    setFaderDrag(true);
    const track = e.currentTarget.parentElement;
    const rect = track.getBoundingClientRect();
    const PAD = 8;
    const update = (clientY) => {
      const usable = rect.height - PAD * 2;
      const v = 1 - (clientY - rect.top - PAD) / usable;
      onFader(Math.max(0, Math.min(1, v)));
    };
    update(e.clientY);
    const onMove = (ev) => update(ev.clientY);
    const onUp = () => {
      setFaderDrag(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const onPanMouseDown = (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startV = channel.pan;
    const onMove = (ev) => {
      const dv = (startY - ev.clientY) / 100;
      onPan(Math.max(-1, Math.min(1, startV + dv)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const dbLabel = (v) => {
    if (v <= 0.001) return '-∞';
    const db = 20 * Math.log10(v);
    return (db >= 0 ? '+' : '') + db.toFixed(1);
  };

  return (
    <div
      className={`strip ${selected ? 'sel' : ''} ${isMaster ? 'master' : ''} ${isBus ? 'bus' : ''} ${dropHover ? 'drop' : ''}`}
      style={{ '--track': color }}
      onClick={onSelect}
      onDragOver={(e) => { e.preventDefault(); setDropHover(true); }}
      onDragLeave={() => setDropHover(false)}
      onDrop={(e) => { onDrop(e); setDropHover(false); }}
    >
      <div className="strip-color-bar" />

      <div className="strip-name" title={channel.name}>{channel.name}</div>

      <button
        className="pan-knob"
        onMouseDown={onPanMouseDown}
        title={`Pan ${channel.pan > 0 ? 'R' : channel.pan < 0 ? 'L' : 'C'}${Math.abs(channel.pan * 100).toFixed(0)}`}
      >
        <svg viewBox="0 0 36 36" width="34" height="34">
          <circle cx="18" cy="18" r="13" className="pan-bg" />
          <line
            x1="18" y1="18"
            x2={18 + Math.sin(channel.pan * Math.PI * 0.7) * 10}
            y2={18 - Math.cos(channel.pan * Math.PI * 0.7) * 10}
            stroke="currentColor" strokeWidth="2" strokeLinecap="round"
          />
          <circle cx="18" cy="18" r="2" fill="currentColor" />
        </svg>
      </button>

      <div className="strip-ms-row">
        <button className={`tlet mute ${channel.mute ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); onMute(); }}>M</button>
        <button className={`tlet solo ${channel.solo ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); onSolo(); }}>S</button>
      </div>

      <div className="strip-combo">
        <div className="combo-track">
          <div className="combo-ticks" aria-hidden="true">
            <span style={{ top: '0%' }}>0</span>
            <span style={{ top: '25%' }}>-6</span>
            <span style={{ top: '50%' }}>-12</span>
            <span style={{ top: '75%' }}>-24</span>
          </div>
          <div className="combo-meter l">
            <div className="meter-fill" style={{ height: `${(level || 0) * 100}%` }} />
          </div>
          <div className="combo-rail">
            <div className="combo-fill" style={{ height: `${channel.vol * 100}%` }} />
          </div>
          <div className="combo-meter r">
            <div className="meter-fill" style={{ height: `${(level2 || (level || 0) * 0.95) * 100}%` }} />
          </div>
          <button
            className={`combo-cap ${faderDrag ? 'drag' : ''}`}
            style={{ bottom: `calc(${channel.vol} * (100% - 16px) + 8px - 5px)` }}
            onMouseDown={onFaderMouseDown}
            title="Drag to adjust"
          >
            <div className="cap-line" />
          </button>
        </div>
      </div>

      <div className="strip-foot">
        <div className="strip-db mono">{dbLabel(channel.vol)}</div>
        {fxCount > 0 && (
          <div className="strip-fxcount mono" title={`${fxCount} effect${fxCount > 1 ? 's' : ''}`}>
            {fxCount} FX
          </div>
        )}
      </div>
    </div>
  );
}

function FxPanel({ channel, color, lookup, onRemoveEffect, onBypassEffect, onOpenEditor, onReorderEffect, onSetSendLevel, onDrop }) {
  const [over, setOver] = useState(false);
  if (!channel) return null;
  return (
    <aside
      className={`fx-panel ${over ? 'drop' : ''}`}
      style={{ '--track': color }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { onDrop(e); setOver(false); }}
    >
      <div className="fx-panel-head">
        <div className="fx-panel-eyebrow">EFFECTS RACK</div>
        <div className="fx-panel-title">
          <span className="fx-panel-dot" style={{ background: color }} />
          <span>{channel.name}</span>
        </div>
        <div className="fx-panel-meta mono">
          <span>{channel.effects.length} / 8 slots</span>
          <span>·</span>
          <span>{channel.sends.length ? `routed to ${channel.sends.length}` : 'no sends'}</span>
        </div>
      </div>

      <div className="fx-panel-list">
        {channel.effects.map((fx, i) => (
          <FxCard
            key={fx.id}
            fx={fx}
            index={i}
            total={channel.effects.length}
            color={color}
            info={lookup?.(fx.pluginId)}
            hasUi={lookup?.(fx.pluginId)?.hasUi ?? false}
            onBypass={() => onBypassEffect(fx.id, fx.bypass)}
            onRemove={() => onRemoveEffect(fx.id)}
            onOpenEditor={() => onOpenEditor?.(fx.id)}
            onMoveUp={i > 0 ? () => onReorderEffect?.(channel.id, i, i - 1) : null}
            onMoveDown={i < channel.effects.length - 1
              ? () => onReorderEffect?.(channel.id, i, i + 1) : null}
          />
        ))}

        <button className="fx-add">
          <Icon name="add" size={16} />
          <span>{channel.effects.length === 0 ? 'Drop a plugin here, or click to browse' : 'Add effect'}</span>
        </button>
      </div>

      <div className="fx-panel-foot">
        <div className="fx-routing">
          <Icon name="output" size={12} />
          <span className="mono">SENDS</span>
          <div className="send-list">
            {channel.sends.length === 0 ? (
              <span className="send-empty">none</span>
            ) : (
              channel.sends.map((destId) => (
                <SendRow
                  key={destId}
                  destId={destId}
                  level={channel.sendLevels?.[destId] ?? 1}
                  onChange={(lvl) => onSetSendLevel?.(channel.id, destId, lvl)}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

function SendRow({ destId, level, onChange }) {
  return (
    <span className="send-row">
      <span className="send-chip mono">{destId.replace('m', '#')}</span>
      <input
        className="send-slider"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={level}
        onChange={(e) => onChange?.(parseFloat(e.target.value))}
        title={`Send level → ${destId}: ${Math.round(level * 100)}%`}
      />
      <span className="send-level mono">{Math.round(level * 100)}</span>
    </span>
  );
}

const FX_ICON = { gen: 'synth', fx: 'tune' };

function FxCard({ fx, info, hasUi, onBypass, onRemove, onOpenEditor, onMoveUp, onMoveDown }) {
  const displayName = info?.name ?? fx.pluginId;
  const kind = info?.kind ?? 'fx';
  const wet = kind === 'fx' ? 0.65 : 0.85;
  return (
    <div
      className={`fx-card ${fx.bypass ? 'bypass' : ''}`}
      onDoubleClick={hasUi ? onOpenEditor : undefined}
    >
      <div className="fx-card-grip" title="Drag to reorder">
        <Icon name="drag" size={14} />
      </div>
      <button className={`fx-card-power ${fx.bypass ? 'off' : 'on'}`} onClick={onBypass} title={fx.bypass ? 'Enable' : 'Bypass'}>
        <span className="power-dot" />
      </button>
      <div className="fx-card-thumb">
        <Icon name={FX_ICON[kind] || 'tune'} size={18} />
      </div>
      <div className="fx-card-body">
        <div className="fx-card-row">
          <span className="fx-card-name">{displayName}</span>
          <span className="fx-card-tag mono">{kind.toUpperCase()}</span>
        </div>
        <div className="fx-card-wet">
          <span className="wet-label mono">WET</span>
          <div className="wet-bar"><div className="wet-fill" style={{ width: `${wet * 100}%` }} /></div>
          <span className="wet-val mono">{Math.round(wet * 100)}</span>
        </div>
      </div>
      <div className="fx-card-actions">
        <button
          className="btn-icon tiny"
          title="Move up"
          disabled={!onMoveUp}
          onClick={onMoveUp ?? undefined}
        ><Icon name="chevron_u" size={14} /></button>
        <button
          className="btn-icon tiny"
          title="Move down"
          disabled={!onMoveDown}
          onClick={onMoveDown ?? undefined}
        ><Icon name="chevron_d" size={14} /></button>
        <button
          className="btn-icon tiny"
          title={hasUi ? 'Open editor' : 'No editor'}
          disabled={!hasUi}
          onClick={onOpenEditor}
        ><Icon name="tune" size={14} /></button>
        <button className="btn-icon tiny" title="Remove" onClick={onRemove}><Icon name="close" size={14} /></button>
      </div>
    </div>
  );
}
