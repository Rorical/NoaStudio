import { useState } from 'react';
import Icon from './Icon.jsx';

export default function Browser({
  files, plugins, onDragPlugin, onInstallFromUrl, onUninstall,
}) {
  const [tab, setTab] = useState('files');
  const [query, setQuery] = useState('');
  const [openMap, setOpenMap] = useState(() => ({ Projects: true, Samples: true, Drums: true }));
  const [installModalOpen, setInstallModalOpen] = useState(false);

  const toggle = (key) => setOpenMap((m) => ({ ...m, [key]: !m[key] }));

  const renderNode = (node, depth = 0, path = '') => {
    const key = path + '/' + node.name;
    const isFolder = node.kind === 'folder';
    const open = openMap[node.name];
    const match = query && !node.name.toLowerCase().includes(query.toLowerCase());
    if (match && !isFolder) return null;

    const iconName = isFolder
      ? (open ? 'folder_open' : 'folder')
      : node.kind === 'audio' ? 'audio'
      : node.kind === 'midi' ? 'midi'
      : 'file';

    return (
      <div key={key}>
        <div
          className={`tree-node ${isFolder ? 'folder' : 'leaf'} ${node.open ? 'is-open' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => isFolder && toggle(node.name)}
          draggable={!isFolder}
        >
          {isFolder && <Icon name={open ? 'chevron_d' : 'chevron_r'} size={14} />}
          {!isFolder && <span style={{ width: 14 }} />}
          <Icon name={iconName} size={16} />
          <span className="tree-name">{node.name}</span>
        </div>
        {isFolder && open && node.children && node.children.map((c) => renderNode(c, depth + 1, key))}
      </div>
    );
  };

  const filtered = plugins.filter((p) =>
    !query ||
    p.name.toLowerCase().includes(query.toLowerCase()) ||
    (p.tag ?? '').toLowerCase().includes(query.toLowerCase()),
  );
  const generators = filtered.filter((p) => p.kind === 'gen');
  const effects = filtered.filter((p) => p.kind === 'fx');

  const onDragStart = (e, p) => {
    e.dataTransfer.setData('plugin', JSON.stringify(p));
    onDragPlugin?.(p);
  };

  const renderPluginCard = (p, className) => (
    <div
      key={p.pluginId ?? p.name}
      className={`plugin-card ${className}`}
      draggable
      onDragStart={(e) => onDragStart(e, p)}
    >
      <div className={`plugin-thumb ${className === 'fx' ? 'fx' : ''}`}>
        <Icon name={className === 'fx' ? 'tune' : 'synth'} size={18} />
      </div>
      <div className="plugin-meta">
        <div className="plugin-name">{p.name}</div>
        <div className="plugin-tag">{p.tag}</div>
      </div>
      {onUninstall && p.pluginId && (
        <button
          className="btn-icon tiny plugin-uninstall"
          title={`Uninstall ${p.name}`}
          onClick={(e) => { e.stopPropagation(); onUninstall(p.pluginId); }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <Icon name="close" size={12} />
        </button>
      )}
      <Icon name="drag" size={14} className="plugin-drag" />
    </div>
  );

  return (
    <aside className="browser">
      <div className="browser-tabs">
        <button className={`browser-tab ${tab === 'files' ? 'active' : ''}`} onClick={() => setTab('files')}>
          <Icon name="folder" size={16} /> Browser
        </button>
        <button className={`browser-tab ${tab === 'plugins' ? 'active' : ''}`} onClick={() => setTab('plugins')}>
          <Icon name="bolt" size={16} /> Plugins
        </button>
      </div>

      <div className="browser-search">
        <Icon name="search" size={16} />
        <input
          placeholder={tab === 'files' ? 'Search files…' : 'Search plugins…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="btn-icon tiny" onClick={() => setQuery('')}>
            <Icon name="close" size={14} />
          </button>
        )}
      </div>

      <div className="browser-body">
        {tab === 'files' ? (
          <div className="tree">
            {files.map((f) => renderNode(f))}
          </div>
        ) : (
          <div className="plugin-list">
            <div className="plugin-section">
              <div className="plugin-section-h">
                <Icon name="synth" size={14} /> Generators <span className="count">{generators.length}</span>
              </div>
              {generators.map((p) => renderPluginCard(p, 'gen'))}
            </div>
            <div className="plugin-section">
              <div className="plugin-section-h">
                <Icon name="tune" size={14} /> Effects <span className="count">{effects.length}</span>
              </div>
              {effects.map((p) => renderPluginCard(p, 'fx'))}
            </div>
            {onInstallFromUrl && (
              <div className="plugin-section">
                <button
                  className="btn plugin-install-btn"
                  onClick={() => setInstallModalOpen(true)}
                >
                  <Icon name="add" size={14} /> Install plugin from URL…
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="browser-foot">
        <span className="mono">{tab === 'files' ? '4 folders' : `${plugins.length} plugins`}</span>
        <button className="btn-icon tiny" title="More"><Icon name="more_h" size={14} /></button>
      </div>

      {installModalOpen && (
        <InstallFromUrlModal
          onClose={() => setInstallModalOpen(false)}
          onInstall={onInstallFromUrl}
        />
      )}
    </aside>
  );
}

function InstallFromUrlModal({ onClose, onInstall }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onInstall(url.trim());
      onClose();
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <span>Install plugin from URL</span>
          <button type="button" className="btn-icon tiny" onClick={onClose} title="Close">
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="modal-body">
          <label className="modal-label">
            <span>URL (.noaplugin)</span>
            <input
              autoFocus
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/plugin.noaplugin#sha256-…"
              disabled={busy}
            />
          </label>
          {error && <div className="modal-error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !url.trim()}>
            {busy ? 'Installing…' : 'Install'}
          </button>
        </div>
      </form>
    </div>
  );
}
