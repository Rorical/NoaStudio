import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_VERSION,
  isReady, isStateSnapshotRequest, isStateSnapshotResponse,
  type HostToIframe, type IframeToHost,
} from '../PluginUIProtocol';
import { ABI_VERSION } from '../PluginAbi';
import { parseManifest } from '../PluginManifest';

const manifest = parseManifest({
  id: 'com.noa.test', name: 'Test', version: '0.0.1', abi_version: 1, kind: 'fx',
  params: [{ name: 'Volume', min: 0, max: 1, default: 0.5 }],
});

describe('PluginUIProtocol', () => {
  it('exposes protocol version 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('HELLO envelope shape is well-typed', () => {
    const msg: HostToIframe = {
      type: 'HELLO',
      protocolVersion: PROTOCOL_VERSION,
      instanceId: 'i_abc',
      abiVersion: ABI_VERSION,
      manifest,
      initialParams: [0.5],
      paramRingSab: new SharedArrayBuffer(64),
      notifyRingSab: new SharedArrayBuffer(32),
    };
    expect(msg.protocolVersion).toBe(1);
    expect(msg.instanceId).toBe('i_abc');
    expect(msg.manifest.id).toBe('com.noa.test');
  });

  it('STATE_RESTORE envelope shape', () => {
    const msg: HostToIframe = {
      type: 'STATE_RESTORE',
      bytes: new Uint8Array([1, 2, 3, 4]),
    };
    expect(msg.bytes.length).toBe(4);
  });

  it('READY validator', () => {
    const msg: IframeToHost = { type: 'READY' };
    expect(isReady(msg)).toBe(true);
    expect(isReady({ type: 'WHATEVER' })).toBe(false);
    expect(isReady(null)).toBe(false);
    expect(isReady('READY')).toBe(false);
  });

  it('STATE_SNAPSHOT_REQUEST validator', () => {
    const msg: IframeToHost = { type: 'STATE_SNAPSHOT_REQUEST', requestId: 'r1' };
    expect(isStateSnapshotRequest(msg)).toBe(true);
    expect(isStateSnapshotRequest({ type: 'STATE_SNAPSHOT_REQUEST' })).toBe(false);
    expect(isStateSnapshotRequest({ type: 'STATE_SNAPSHOT_REQUEST', requestId: 99 })).toBe(false);
  });

  it('STATE_SNAPSHOT_RESPONSE validator', () => {
    const msg: IframeToHost = {
      type: 'STATE_SNAPSHOT_RESPONSE',
      requestId: 'r1',
      bytes: new Uint8Array([7]),
    };
    expect(isStateSnapshotResponse(msg)).toBe(true);
    expect(isStateSnapshotResponse({
      type: 'STATE_SNAPSHOT_RESPONSE', requestId: 'r1', bytes: [7],
    })).toBe(false);
    expect(isStateSnapshotResponse({
      type: 'STATE_SNAPSHOT_RESPONSE', requestId: 'r1',
    })).toBe(false);
  });
});
