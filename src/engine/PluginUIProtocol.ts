/**
 * Iframe ↔ host postMessage envelopes.
 *
 * Two lanes carry messages between a plugin's UI iframe and the host:
 *
 *  - **Control lane (postMessage):** lifecycle handshake, state save/restore.
 *    JSON-shaped, low rate, easy to log and test.
 *  - **Real-time lane (SAB rings):** parameter writes from the UI (paramRing),
 *    parameter notifications from the engine (notifyRing). Bypasses the
 *    main-thread postMessage queue entirely.
 *
 * Both lanes are documented in the design spec; this file is the on-the-wire
 * shape for the control lane plus a couple of structural validators.
 */

import type { PluginManifest } from './PluginManifest';

export const PROTOCOL_VERSION = 1 as const;

/** host → iframe */
export interface HelloMessage {
  type: 'HELLO';
  protocolVersion: typeof PROTOCOL_VERSION;
  instanceId: string;
  abiVersion: number;
  manifest: PluginManifest;
  initialParams: number[];
  paramRingSab: SharedArrayBuffer;
  notifyRingSab: SharedArrayBuffer;
}

/** host → iframe */
export interface StateRestoreMessage {
  type: 'STATE_RESTORE';
  bytes: Uint8Array;
}

export type HostToIframe = HelloMessage | StateRestoreMessage;

/** iframe → host: iframe is loaded and ready for HELLO. */
export interface ReadyMessage {
  type: 'READY';
}

/** iframe → host: the iframe wants the plugin's current state for a "save preset" UI. */
export interface StateSnapshotRequestMessage {
  type: 'STATE_SNAPSHOT_REQUEST';
  requestId: string;
}

/** iframe → host: the iframe is shipping the bytes it captured. */
export interface StateSnapshotResponseMessage {
  type: 'STATE_SNAPSHOT_RESPONSE';
  requestId: string;
  bytes: Uint8Array;
}

export type IframeToHost =
  | ReadyMessage
  | StateSnapshotRequestMessage
  | StateSnapshotResponseMessage;

export function isReady(msg: unknown): msg is ReadyMessage {
  return !!msg && typeof msg === 'object' && (msg as { type?: unknown }).type === 'READY';
}

export function isStateSnapshotRequest(msg: unknown): msg is StateSnapshotRequestMessage {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as { type?: unknown; requestId?: unknown };
  return m.type === 'STATE_SNAPSHOT_REQUEST' && typeof m.requestId === 'string';
}

export function isStateSnapshotResponse(msg: unknown): msg is StateSnapshotResponseMessage {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as { type?: unknown; requestId?: unknown; bytes?: unknown };
  return m.type === 'STATE_SNAPSHOT_RESPONSE'
    && typeof m.requestId === 'string'
    && m.bytes instanceof Uint8Array;
}
