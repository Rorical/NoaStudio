import { useEffect, useRef, useState } from 'react';

const TWEAKS_STYLE = `
  .twk-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:280px;
    max-height:calc(100vh - 32px);display:flex;flex-direction:column;
    background:rgba(28,30,34,.92);color:#e6e7ec;
    -webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%);
    border:.5px solid rgba(255,255,255,.08);border-radius:14px;
    box-shadow:0 1px 0 rgba(255,255,255,.06) inset,0 12px 40px rgba(0,0,0,.45);
    font:11.5px/1.4 'Plus Jakarta Sans',ui-sans-serif,system-ui,sans-serif;overflow:hidden}
  [data-theme="light"] .twk-panel{background:rgba(250,249,247,.92);color:#29261b;
    border-color:rgba(0,0,0,.08);box-shadow:0 1px 0 rgba(255,255,255,.5) inset,0 12px 40px rgba(0,0,0,.18)}
  .twk-hd{display:flex;align-items:center;justify-content:space-between;
    padding:10px 8px 10px 14px;cursor:move;user-select:none}
  .twk-hd b{font-size:12px;font-weight:600;letter-spacing:.01em}
  .twk-x{appearance:none;border:0;background:transparent;color:rgba(230,231,236,.55);
    width:22px;height:22px;border-radius:6px;cursor:pointer;font-size:13px;line-height:1}
  .twk-x:hover{background:rgba(255,255,255,.08);color:#e6e7ec}
  [data-theme="light"] .twk-x{color:rgba(41,38,27,.55)}
  [data-theme="light"] .twk-x:hover{background:rgba(0,0,0,.06);color:#29261b}
  .twk-body{padding:2px 14px 14px;display:flex;flex-direction:column;gap:10px;
    overflow-y:auto;overflow-x:hidden;min-height:0}
  .twk-row{display:flex;flex-direction:column;gap:5px}
  .twk-row-h{flex-direction:row;align-items:center;justify-content:space-between;gap:10px}
  .twk-lbl{display:flex;justify-content:space-between;align-items:baseline;
    color:rgba(230,231,236,.72)}
  [data-theme="light"] .twk-lbl{color:rgba(41,38,27,.72)}
  .twk-lbl>span:first-child{font-weight:500}
  .twk-sect{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
    color:rgba(230,231,236,.45);padding:10px 0 0}
  [data-theme="light"] .twk-sect{color:rgba(41,38,27,.45)}
  .twk-sect:first-child{padding-top:0}
  .twk-seg{position:relative;display:flex;padding:2px;border-radius:8px;
    background:rgba(255,255,255,.06);user-select:none}
  [data-theme="light"] .twk-seg{background:rgba(0,0,0,.06)}
  .twk-seg-thumb{position:absolute;top:2px;bottom:2px;border-radius:6px;
    background:rgba(255,255,255,.14);box-shadow:0 1px 2px rgba(0,0,0,.3);
    transition:left .15s cubic-bezier(.3,.7,.4,1),width .15s}
  [data-theme="light"] .twk-seg-thumb{background:rgba(255,255,255,.9);box-shadow:0 1px 2px rgba(0,0,0,.12)}
  .twk-seg button{appearance:none;position:relative;z-index:1;flex:1;border:0;
    background:transparent;color:inherit;font:inherit;font-weight:500;min-height:22px;
    border-radius:6px;cursor:pointer;padding:4px 6px;line-height:1.2}
`;

export default function TweaksPanel({ open, onClose, theme, onTheme }) {
  const panelRef = useRef(null);
  const offsetRef = useRef({ x: 16, y: 16 });
  const [, force] = useState(0);

  useEffect(() => {
    if (!open) return;
    const clamp = () => {
      const el = panelRef.current;
      if (!el) return;
      const w = el.offsetWidth, h = el.offsetHeight;
      const PAD = 16;
      offsetRef.current = {
        x: Math.min(Math.max(PAD, window.innerWidth - w - PAD), Math.max(PAD, offsetRef.current.x)),
        y: Math.min(Math.max(PAD, window.innerHeight - h - PAD), Math.max(PAD, offsetRef.current.y)),
      };
      el.style.right = offsetRef.current.x + 'px';
      el.style.bottom = offsetRef.current.y + 'px';
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [open]);

  const onDragStart = (e) => {
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const startRight = window.innerWidth - r.right;
    const startBottom = window.innerHeight - r.bottom;
    const move = (ev) => {
      offsetRef.current = {
        x: Math.max(16, startRight - (ev.clientX - sx)),
        y: Math.max(16, startBottom - (ev.clientY - sy)),
      };
      el.style.right = offsetRef.current.x + 'px';
      el.style.bottom = offsetRef.current.y + 'px';
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      force((n) => n + 1);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  if (!open) return null;

  const opts = [
    { value: 'dark', label: 'Dark' },
    { value: 'light', label: 'Light' },
  ];
  const idx = Math.max(0, opts.findIndex((o) => o.value === theme));

  return (
    <>
      <style>{TWEAKS_STYLE}</style>
      <div
        ref={panelRef}
        className="twk-panel"
        style={{ right: offsetRef.current.x, bottom: offsetRef.current.y }}
      >
        <div className="twk-hd" onMouseDown={onDragStart}>
          <b>Tweaks</b>
          <button className="twk-x" onMouseDown={(e) => e.stopPropagation()} onClick={onClose}>✕</button>
        </div>
        <div className="twk-body">
          <div className="twk-sect">Appearance</div>
          <div className="twk-row">
            <div className="twk-lbl"><span>Theme</span></div>
            <div className="twk-seg" role="radiogroup">
              <div
                className="twk-seg-thumb"
                style={{
                  left: `calc(2px + ${idx} * (100% - 4px) / ${opts.length})`,
                  width: `calc((100% - 4px) / ${opts.length})`,
                }}
              />
              {opts.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={o.value === theme}
                  onClick={() => onTheme(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
