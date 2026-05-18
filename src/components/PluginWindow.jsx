import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { PluginUIHost } from '../engine/PluginUIHost.ts';

const uiHost = new PluginUIHost();

/**
 * Floating panel that hosts a plugin's HTML UI in an iframe. The iframe
 * lifecycle (Blob URL, postMessage HELLO, SAB rings) lives in PluginUIHost;
 * this component owns the chrome (drag, z-order, close) and the dom node
 * the iframe lives in.
 */
export default function PluginWindow({
  instanceId,
  manifest,
  uiAssets,
  initialParams,
  paramRingSab,
  notifyRingSab,
  position,
  zIndex,
  onFocus,
  onClose,
  onPresetRequest,
  serviceWorker,
}) {
  const panelRef = useRef(null);
  const containerRef = useRef(null);
  const [pos, setPos] = useState(position ?? { x: 80, y: 120 });

  // Stable ref to the preset callback so onPresetRequest prop changes
  // don't tear down the iframe.
  const presetCbRef = useRef(onPresetRequest);
  useEffect(() => { presetCbRef.current = onPresetRequest; }, [onPresetRequest]);

  // Spawn the iframe once after mount; tear down on unmount or instance change.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const opened = uiHost.openWindow({
      instanceId, manifest, uiAssets, initialParams,
      paramRingSab, notifyRingSab,
      container,
      onPresetRequest: (bytes) => presetCbRef.current?.(instanceId, bytes),
      serviceWorker,
    });
    return () => opened.close();
  }, [instanceId, manifest, uiAssets, initialParams, paramRingSab, notifyRingSab, serviceWorker]);

  // Clamp to viewport on resize.
  useEffect(() => {
    const onResize = () => {
      const el = panelRef.current;
      if (!el) return;
      const w = el.offsetWidth, h = el.offsetHeight;
      setPos((p) => ({
        x: Math.min(Math.max(8, window.innerWidth - w - 8), Math.max(8, p.x)),
        y: Math.min(Math.max(8, window.innerHeight - h - 8), Math.max(8, p.y)),
      }));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onDragStart = (e) => {
    if (e.button !== 0) return;
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const startX = r.left, startY = r.top;
    const move = (ev) => {
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - r.width, startX + ev.clientX - sx)),
        y: Math.max(0, Math.min(window.innerHeight - r.height, startY + ev.clientY - sy)),
      });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const ui = manifest.ui ?? { width: 280, height: 200 };

  return (
    <div
      ref={panelRef}
      className="plugin-window"
      style={{
        left: pos.x,
        top: pos.y,
        width: ui.width,
        height: ui.height + 32 /* header */,
        zIndex,
      }}
      onMouseDown={onFocus}
    >
      <div className="plugin-window-head" onMouseDown={onDragStart}>
        <span className="plugin-window-dot" />
        <span className="plugin-window-title">{manifest.name}</span>
        <button
          className="plugin-window-x"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onClose}
          title="Close"
        >
          <Icon name="close" size={12} />
        </button>
      </div>
      <div ref={containerRef} className="plugin-window-body" />
    </div>
  );
}
