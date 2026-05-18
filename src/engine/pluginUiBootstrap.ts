/**
 * Bootstrap script injected into every plugin UI HTML page (Blob URL fallback
 * or SW-served `/_noa/plugin-ui/...` entry). Exposes `window.__noa` with the
 * handful of helpers a plugin UI needs to talk to the host: setParam,
 * pollNotify, onReady, applyPreset, plus the post-HELLO instance metadata.
 *
 * Two consumers:
 *  - `PluginUIHost.openWindow` (Blob path) — injects into the HTML before
 *    handing it to URL.createObjectURL.
 *  - `SwCore.handleFetch` (SW path) — injects into HTML responses for
 *    `/_noa/plugin-ui/<instanceId>/<file>.html`.
 *
 * Keep this file dependency-free: it ships as inline text inside an iframe
 * that runs the bootstrap as plain JS, so anything imported here would have
 * to be embeddable as a string.
 */

export const PLUGIN_UI_BOOTSTRAP = `<script>
(function () {
  var EVT_PARAM_SET = 3;
  var EVENT_FRAME_SIZE = 32;
  var NOTIFY_FRAME_SIZE = 16;
  var RB_HEADER_BYTES = 16;

  function ringHeader(sab) { return new Uint32Array(sab, 0, 4); }

  function pushParamSet(sab, paramIndex, value) {
    var header = ringHeader(sab);
    var write = Atomics.load(header, 0);
    var read = Atomics.load(header, 1);
    var capacity = header[2];
    if (write - read >= capacity) return false;
    var frameSize = header[3];
    var slot = (write & (capacity - 1)) * frameSize;
    var dst = new Uint8Array(sab, RB_HEADER_BYTES + slot, frameSize);
    for (var i = 0; i < frameSize; i++) dst[i] = 0;
    var view = new DataView(sab, RB_HEADER_BYTES + slot, frameSize);
    view.setUint8(0, EVT_PARAM_SET);
    view.setUint32(12, paramIndex >>> 0, true);
    view.setFloat32(16, value, true);
    Atomics.store(header, 0, write + 1);
    return true;
  }

  function popNotify(sab) {
    var header = ringHeader(sab);
    var write = Atomics.load(header, 0);
    var read = Atomics.load(header, 1);
    if (read === write) return null;
    var capacity = header[2];
    var frameSize = header[3];
    var slot = (read & (capacity - 1)) * frameSize;
    var view = new DataView(sab, RB_HEADER_BYTES + slot, frameSize);
    var msg = {
      type: view.getUint8(0),
      paramIndex: view.getUint32(4, true),
      value: view.getFloat32(8, true),
      blockCounter: view.getUint32(12, true),
    };
    Atomics.store(header, 1, read + 1);
    return msg;
  }

  var noa = {
    instanceId: null,
    manifest: null,
    initialParams: null,
    paramRingSab: null,
    notifyRingSab: null,
    _readyCbs: [],
    onReady: function (cb) {
      if (noa.manifest) { try { cb(); } catch (e) { console.error(e); } }
      else noa._readyCbs.push(cb);
    },
    setParam: function (paramIndex, value) {
      if (!noa.paramRingSab) return false;
      return pushParamSet(noa.paramRingSab, paramIndex, value);
    },
    pollNotify: function () {
      if (!noa.notifyRingSab) return null;
      return popNotify(noa.notifyRingSab);
    },
    applyPreset: function (bytes) {
      if (!(bytes instanceof Uint8Array)) {
        console.error('[noa] applyPreset: bytes must be a Uint8Array');
        return false;
      }
      try {
        window.parent.postMessage({ type: 'PRESET_REQUEST', bytes: bytes }, '*');
        return true;
      } catch (err) {
        console.error('[noa] applyPreset failed', err);
        return false;
      }
    },
  };
  window.__noa = noa;

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.type !== 'HELLO') return;
    noa.instanceId = d.instanceId;
    noa.manifest = d.manifest;
    noa.initialParams = d.initialParams;
    noa.paramRingSab = d.paramRingSab;
    noa.notifyRingSab = d.notifyRingSab;
    var cbs = noa._readyCbs;
    noa._readyCbs = [];
    cbs.forEach(function (cb) { try { cb(); } catch (err) { console.error(err); } });
  });

  function announceReady() {
    try { window.parent.postMessage({ type: 'READY' }, '*'); }
    catch (err) { console.error('[noa] postMessage to parent failed', err); }
  }
  if (document.readyState === 'complete') announceReady();
  else window.addEventListener('load', announceReady);
})();
</script>`;

/**
 * Inject the bootstrap into a user-supplied HTML string. Prefer placing it at
 * the end of `<head>` so it runs before any plugin scripts; fall back to the
 * start of `<body>` and finally to prepending it for raw HTML fragments.
 */
export function injectBootstrap(userHtml: string): string {
  if (/<\/head\s*>/i.test(userHtml)) {
    return userHtml.replace(/<\/head\s*>/i, PLUGIN_UI_BOOTSTRAP + '$&');
  }
  if (/<body[^>]*>/i.test(userHtml)) {
    return userHtml.replace(/<body([^>]*)>/i, '<body$1>' + PLUGIN_UI_BOOTSTRAP);
  }
  return PLUGIN_UI_BOOTSTRAP + userHtml;
}
