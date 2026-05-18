import { ABI_VERSION } from './PluginAbi';
import type { PluginManifest } from './PluginManifest';
import {
  PROTOCOL_VERSION,
  isReady, isPresetRequest,
  type HelloMessage,
  type IframeToHost,
} from './PluginUIProtocol';
import { injectBootstrap } from './pluginUiBootstrap';

export interface OpenWindowArgs {
  instanceId: string;
  manifest: PluginManifest;
  /** Map of relative UI path → bytes. Must contain `manifest.ui.entry`. Only
   *  consulted on the Blob URL fallback path; the SW path streams from OPFS. */
  uiAssets: Map<string, Uint8Array>;
  initialParams: number[];
  paramRingSab: SharedArrayBuffer;
  notifyRingSab: SharedArrayBuffer;
  container: HTMLElement;
  onPresetRequest?: (bytes: Uint8Array) => void;
  /**
   * When provided, the iframe loads from `/_noa/plugin-ui/<instanceId>/<entry>`
   * and the host posts `BIND_INSTANCE` to the worker on open and
   * `UNBIND_INSTANCE` on close. Falls back to the Blob URL path when omitted.
   */
  serviceWorker?: ServiceWorker | null;
}

export interface OpenedWindow {
  iframe: HTMLIFrameElement;
  close: () => void;
}

/**
 * Per-instance iframe lifecycle for plugin UIs. Two paths:
 *
 *  - **Service Worker path** (preferred when `args.serviceWorker` is set): the
 *    iframe `src` points at `/_noa/plugin-ui/<instanceId>/<entry>`, which the
 *    SW resolves against OPFS. Sub-resources (CSS, fonts, scripts) referenced
 *    from the HTML work because they resolve relative to the same SW namespace.
 *    The SW injects the bootstrap when serving HTML so plugin authors don't
 *    need to embed it themselves.
 *
 *  - **Blob URL fallback**: the host inlines the bootstrap into the HTML and
 *    points the iframe at a Blob URL. Sub-resources only work if the plugin
 *    inlines them, which is why the SW path is preferred.
 *
 * Sandbox: `allow-scripts allow-same-origin`. `allow-same-origin` is required
 * because SharedArrayBuffer postMessage only crosses iframe boundaries within
 * the same agent cluster; a fully opaque sandbox isolates the iframe into its
 * own cluster and the SAB transfer fails.
 */
export class PluginUIHost {
  openWindow(args: OpenWindowArgs): OpenedWindow {
    if (!args.manifest.ui) {
      throw new Error(`PluginUIHost: ${args.manifest.id} has no UI manifest entry`);
    }
    return args.serviceWorker
      ? this.openViaServiceWorker(args, args.serviceWorker)
      : this.openViaBlob(args);
  }

  private openViaBlob(args: OpenWindowArgs): OpenedWindow {
    const entry = args.manifest.ui!.entry;
    const entryBytes = args.uiAssets.get(entry);
    if (!entryBytes) {
      throw new Error(`PluginUIHost: ${args.manifest.id} uiAssets missing ${entry}`);
    }
    const html = injectBootstrap(new TextDecoder('utf-8').decode(entryBytes));
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);

    const iframe = this.makeIframe(url, args);
    const detachMessage = this.attachMessageListener(iframe, args);
    args.container.appendChild(iframe);

    let closed = false;
    return {
      iframe,
      close: () => {
        if (closed) return;
        closed = true;
        detachMessage();
        URL.revokeObjectURL(url);
        iframe.remove();
      },
    };
  }

  private openViaServiceWorker(args: OpenWindowArgs, sw: ServiceWorker): OpenedWindow {
    sw.postMessage({
      type: 'BIND_INSTANCE',
      instanceId: args.instanceId,
      pluginId: args.manifest.id,
      version: args.manifest.version,
    });
    const url = `/_noa/plugin-ui/${encodeURIComponent(args.instanceId)}/${args.manifest.ui!.entry}`;

    const iframe = this.makeIframe(url, args);
    const detachMessage = this.attachMessageListener(iframe, args);
    args.container.appendChild(iframe);

    let closed = false;
    return {
      iframe,
      close: () => {
        if (closed) return;
        closed = true;
        detachMessage();
        try {
          sw.postMessage({ type: 'UNBIND_INSTANCE', instanceId: args.instanceId });
        } catch { /* SW might have died; nothing to clean up */ }
        iframe.remove();
      },
    };
  }

  private makeIframe(src: string, args: OpenWindowArgs): HTMLIFrameElement {
    const iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';
    iframe.style.display = 'block';
    iframe.title = `${args.manifest.name} plugin UI`;
    return iframe;
  }

  private attachMessageListener(iframe: HTMLIFrameElement, args: OpenWindowArgs): () => void {
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
        return;
      }
      if (isPresetRequest(msg)) {
        args.onPresetRequest?.(msg.bytes);
        return;
      }
      // STATE_SNAPSHOT_* messages are part of the protocol but unused in v1.
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }
}
