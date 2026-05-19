/**
 * Pure helpers that translate coordinator state into a `RoutingConfig` for the
 * audio worklet's MixerRouter. Lifted out of App.jsx so the topo sort + send
 * fan-out logic can be unit-tested without a React tree.
 */
import type { RoutingConfig } from './MixerRouter';

export interface RoutingTrack {
  id: string;
  channel: number;
  generator?: unknown;
  mute?: boolean;
  solo?: boolean;
  vol?: number;
}

export interface RoutingChannel {
  id: string;
  vol?: number;
  pan?: number;
  mute?: boolean;
  solo?: boolean;
  sends?: string[];
  sendLevels?: Record<string, number>;
}

/**
 * Build a RoutingConfig from the coordinator's tracks + channels.
 *
 * - Tracks without a generator are dropped.
 * - `chainId === trackId` and `fxChainId === channelId` — the diff-sync in
 *   App.jsx installs chains under those ids.
 * - Each channel's `sends` array becomes `sendsTo`; per-destination levels
 *   come from `sendLevels`, defaulting to 1.0.
 * - `channelOrder` is the topological order over the send graph.
 */
export function buildRoutingConfig(
  tracks: RoutingTrack[],
  channels: RoutingChannel[],
): RoutingConfig {
  return {
    tracks: tracks
      .filter((t) => t.generator)
      .map((t) => ({
        id: t.id,
        chainId: t.id,
        channelId: 'm' + t.channel,
        mute: !!t.mute,
        solo: !!t.solo,
        vol: t.vol ?? 1,
      })),
    channels: channels.map((c) => {
      const sendsTo = (c.sends ?? []).slice();
      const sendsLevels = sendsTo.map((dest) => c.sendLevels?.[dest] ?? 1);
      return {
        id: c.id,
        fxChainId: c.id,
        vol: c.vol ?? 1,
        pan: c.pan ?? 0,
        mute: !!c.mute,
        solo: !!c.solo,
        sendsTo,
        sendsLevels,
      };
    }),
    channelOrder: topoSortChannels(channels),
  };
}

/**
 * Topological order over the channel send graph. Sources first, sinks last
 * — so master (no outgoing sends) processes after every channel that feeds
 * it. Fan-out: a channel can send to several destinations; each contributes
 * one incoming edge to its target. Cycles cause the remaining cycle members
 * to be appended at the end in their original order; the router runs them
 * but they accumulate stale audio (an audible warning rather than a crash).
 */
export function topoSortChannels(channels: RoutingChannel[]): string[] {
  const ids = channels.map((c) => c.id);
  const idSet = new Set(ids);
  const inDeg = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const c of channels) {
    for (const dest of c.sends ?? []) {
      if (idSet.has(dest)) inDeg.set(dest, (inDeg.get(dest) ?? 0) + 1);
    }
  }
  const order: string[] = [];
  const queue = ids.filter((id) => inDeg.get(id) === 0);
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    const c = channels.find((x) => x.id === id);
    for (const dest of c?.sends ?? []) {
      if (!idSet.has(dest)) continue;
      inDeg.set(dest, (inDeg.get(dest) ?? 0) - 1);
      if (inDeg.get(dest) === 0) queue.push(dest);
    }
  }
  for (const id of ids) if (!order.includes(id)) order.push(id);
  return order;
}
