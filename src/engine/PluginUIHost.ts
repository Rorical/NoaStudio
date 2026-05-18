import { ABI_VERSION } from './PluginAbi';
import type { PluginManifest } from './PluginManifest';
import {
  PROTOCOL_VERSION,
  isReady,
  type HelloMessage,
  type IframeToHost,
} from './PluginUIProtocol';

export interface OpenWindowArgs {
  instanceId: string;
  manifest: PluginManifest;
  /** Map of relative UI path → bytes. Must contain `manifest.ui.entry`. */
  uiAssets: Map<string, Uint8Array>;
  initialParams: number[];
  paramRingSab: SharedArrayBuffer;
  notifyRingSab: SharedArrayBuffer;
  /** DOM element the iframe is appended into; sized by the parent. */
  container: HTMLElement;
}

export interface OpenedWindow {
  iframe: HTMLIFrameElement;
  close: () => void;
}

/**
 * Per-instance iframe lifecycle for plugin UIs.
 *
 * The iframe runs the plugin's HTML inside a Blob URL with
 * `sandbox="allow-scripts allow-same-origin"`. `allow-same-origin` is required
 * because SharedArrayBuffer postMessage only crosses iframe boundaries within
 * the same agent cluster, and a sandbox without `allow-same-origin` opaques
 * the iframe's origin into its own cluster.
 *
 * Bootstrap script prepended to every UI bundle:
 *   - sets up `window.__noa` with `onReady`, `setParam`, `pollNotify`, `manifest`,
 *     `initialParams`;
 *   - posts READY to the parent on `window.load`;
 *   - replies to HELLO by populating the globals and firing onReady callbacks.
 *
 * Plugin HTML stays minimal: knobs, sliders, scopes — anything that doesn't
 * need to know the ring binary format.
 */
export class PluginUIHost {
  openWindow(args: OpenWindowArgs): OpenedWindow {
    if (!args.manifest.ui) {
      throw new Error(`PluginUIHost: ${args.manifest.id} has no UI manifest entry`);
    }
    const entryBytes = args.uiAssets.get(args.manifest.ui.entry);
    if (!entryBytes) {
      throw new Error(
        `PluginUIHost: ${args.manifest.id} uiAssets missing ${args.manifest.ui.entry}`,
      );
    }
    const userHtml = new TextDecoder('utf-8').decode(entryBytes);
    const html = injectBootstrap(userHtml);
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);

    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';
    iframe.style.display = 'block';
    iframe.title = `${args.manifest.name} plugin UI`;

    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframe.contentWindow) return;
      const msg = e.data as IframeToHost;
      if (isReady(msg)) {
        const hello: HelloMessage = {
          type: 'HELLO',
          protocolVersion: PROTOCOL_VERSION,
          instanceId: args.instanceId,
          abiVersion: ABI_VERSION,
          manifest: args.manifest,
          initialParams: args.initialParams,
          paramRingSab: args.paramRingSab,
          notifyRingSab: args.notifyRingSab,
        };
        iframe.contentWindow!.postMessage(hello, '*');
      }
      // STATE_SNAPSHOT_* are part of the protocol but ignored in Phase 3 —
      // built-in plugin state lives entirely in the WASM instance.
    };

    window.addEventListener('message', onMessage);
    args.container.appendChild(iframe);

    let closed = false;
    return {
      iframe,
      close: () => {
        if (closed) return;
        closed = true;
        window.removeEventListener('message', onMessage);
        URL.revokeObjectURL(url);
        iframe.remove();
      },
    };
  }
}

/**
 * Inline a small bootstrap before any user code. Vanilla JS — must run as
 * plain text inside the iframe, no module imports, no closures captured from
 * outside.
 */
const BOOTSTRAP = `<script>
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

function injectBootstrap(userHtml: string): string {
  if (/<\/head\s*>/i.test(userHtml)) {
    return userHtml.replace(/<\/head\s*>/i, BOOTSTRAP + '$&');
  }
  if (/<body[^>]*>/i.test(userHtml)) {
    return userHtml.replace(/<body([^>]*)>/i, '<body$1>' + BOOTSTRAP);
  }
  return BOOTSTRAP + userHtml;
}
