/**
 * Multi-chain audio router for the worklet. Owns N named chains and a routing
 * topology describing which track audio feeds which mixer channel, which
 * channel sends to which bus, and the per-channel vol/pan/mute/solo state.
 *
 * One MixerRouter lives inside the audio worklet. Per render quantum:
 *
 *   1. Resolve solo/mute → audible tracks.
 *   2. For each audible track, process its generator chain into a per-track
 *      stereo scratch buffer.
 *   3. Sum the scratch buffer into the track's target channel's input mix.
 *   4. Walk channels in topological order (master last):
 *        - If the channel has an FX chain, run it with the mix bus as input.
 *        - Apply vol + pan to produce the channel's stereo output.
 *        - Compute peak / RMS for the meter publish.
 *        - If `sendTo` is non-null, accumulate the output into that channel's
 *          input mix.
 *   5. The master channel's stereo output is written to `outStereo`.
 *
 * The router is decoupled from `PluginChain` via the `RouterChain` interface —
 * tests inject deterministic stubs, production wires real PluginChains.
 */

import { channelHash } from './channelHash';

export interface RouterChain {
  processBlock(blockSize: number, outBus: Float32Array, inBus?: Float32Array): void;
  queueEventFrame(slot: number, frame: Uint8Array): void;
}

/**
 * A non-plugin audio source (e.g. the AudioClipPlayer) mixed into channel input
 * buses each block, after the generator chains and before the channel walk.
 * `mixInto(channelHash)` returns the stereo input bus to add into, or undefined
 * when that channel doesn't exist this block.
 */
export interface AuxAudioSource {
  render(blockSize: number, mixInto: (channelHash: number) => Float32Array | undefined): void;
}

export interface TrackRouting {
  id: string;
  chainId: string;
  channelId: string;
  mute: boolean;
  solo: boolean;
  /** Per-track output gain applied before summing into the channel input
   *  mix. Defaults to 1 when omitted. */
  vol?: number;
}

export interface ChannelRouting {
  id: string;
  fxChainId: string;
  vol: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  /** Every downstream channel this channel feeds. Empty = sink (master). */
  sendsTo: string[];
  /** Per-destination level (1.0 = full). Must be the same length as sendsTo;
   *  omitted entries default to 1.0. */
  sendsLevels?: number[];
}

export interface RoutingConfig {
  tracks: TrackRouting[];
  channels: ChannelRouting[];
  /** Topologically sorted channel ids; master must be last. */
  channelOrder: string[];
}

export interface ChannelMeter {
  channelId: string;
  peak: number;
  rms: number;
}

interface InstanceBinding {
  chainId: string;
  slot: number;
}

export class MixerRouter {
  private readonly chains = new Map<string, RouterChain>();
  private readonly instances = new Map<number, InstanceBinding>();
  private cfg: RoutingConfig = { tracks: [], channels: [], channelOrder: [] };

  /** Per-channel input mix bus, keyed by channelId. Allocated lazily. */
  private readonly channelInputs = new Map<string, Float32Array>();
  /** Per-track scratch buffer for generator output. */
  private readonly trackScratch = new Map<string, Float32Array>();
  /** Per-channel post-FX scratch buffer. */
  private readonly channelOut = new Map<string, Float32Array>();
  /** Reusable meters array — keeps allocations off the audio thread. */
  private readonly meters: ChannelMeter[] = [];
  /** channelHash(id) → channelId, rebuilt on updateRouting so an AuxAudioSource
   *  (which only carries hashes in its event frames) can resolve a channel. */
  private channelByHash = new Map<number, string>();

  constructor(public readonly maxBlockSize: number) {}

  installChain(chainId: string, chain: RouterChain): void {
    this.chains.set(chainId, chain);
  }

  removeChain(chainId: string): RouterChain | undefined {
    const ch = this.chains.get(chainId);
    this.chains.delete(chainId);
    return ch;
  }

  getChain(chainId: string): RouterChain | undefined {
    return this.chains.get(chainId);
  }

  registerInstance(instanceId: number, chainId: string, slot: number): void {
    this.instances.set(instanceId, { chainId, slot });
  }

  unregisterInstance(instanceId: number): void {
    this.instances.delete(instanceId);
  }

  queueEvent(instanceId: number, frame: Uint8Array): void {
    const binding = this.instances.get(instanceId);
    if (!binding) return;
    const chain = this.chains.get(binding.chainId);
    if (!chain) return;
    chain.queueEventFrame(binding.slot, frame);
  }

  updateRouting(cfg: RoutingConfig): void {
    this.cfg = cfg;
    this.channelByHash = new Map(cfg.channels.map((c) => [channelHash(c.id), c.id]));
  }

  processBlock(
    blockSize: number,
    outStereo: Float32Array,
    aux?: AuxAudioSource,
  ): ChannelMeter[] {
    if (blockSize > this.maxBlockSize) {
      throw new Error(`MixerRouter.processBlock: blockSize ${blockSize} > maxBlockSize ${this.maxBlockSize}`);
    }
    if (outStereo.length !== blockSize * 2) {
      throw new Error(`MixerRouter.processBlock: outStereo must be ${blockSize * 2} samples`);
    }

    this.zeroChannelInputs(blockSize);

    const anyTrackSolo = this.cfg.tracks.some((t) => t.solo);
    const anyChannelSolo = this.cfg.channels.some((c) => c.solo);

    for (const track of this.cfg.tracks) {
      if (anyTrackSolo ? !track.solo : track.mute) continue;
      const chain = this.chains.get(track.chainId);
      if (!chain) continue;
      const scratch = this.getOrAllocBuffer(this.trackScratch, track.id, blockSize);
      chain.processBlock(blockSize, scratch);
      const dest = this.getOrAllocBuffer(this.channelInputs, track.channelId, blockSize);
      const gain = track.vol ?? 1;
      if (gain === 1) {
        for (let i = 0; i < blockSize * 2; i++) dest[i]! += scratch[i]!;
      } else if (gain !== 0) {
        for (let i = 0; i < blockSize * 2; i++) dest[i]! += scratch[i]! * gain;
      }
    }

    // Non-plugin audio sources (audio-clip voices) sum into channel input buses
    // alongside generator output, so they pass through the channel's FX, pan,
    // fader and sends just like a generator.
    if (aux) {
      aux.render(blockSize, (h) => {
        const id = this.channelByHash.get(h);
        if (id === undefined) return undefined;
        return this.getOrAllocBuffer(this.channelInputs, id, blockSize);
      });
    }

    this.meters.length = 0;
    outStereo.fill(0, 0, blockSize * 2);

    for (const channelId of this.cfg.channelOrder) {
      const channel = this.cfg.channels.find((c) => c.id === channelId);
      if (!channel) continue;

      const inputMix = this.getOrAllocBuffer(this.channelInputs, channelId, blockSize);
      const fxOut = this.getOrAllocBuffer(this.channelOut, channelId, blockSize);
      const fxChain = this.chains.get(channel.fxChainId);
      if (fxChain) {
        fxChain.processBlock(blockSize, fxOut, inputMix);
      } else {
        fxOut.set(inputMix.subarray(0, blockSize * 2));
      }

      const channelMuted = anyChannelSolo ? !channel.solo : channel.mute;
      const gain = channelMuted ? 0 : channel.vol;
      // Linear pan: -1 = full left, +1 = full right, 0 = no attenuation either
      // side. Equal-power's centre attenuation would cascade through master.
      const lGain = (channel.pan >= 0 ? 1 - channel.pan : 1) * gain;
      const rGain = (channel.pan <= 0 ? 1 + channel.pan : 1) * gain;

      let peak = 0;
      let sumSq = 0;
      for (let i = 0; i < blockSize; i++) {
        const l = fxOut[i * 2]! * lGain;
        const r = fxOut[i * 2 + 1]! * rGain;
        fxOut[i * 2] = l;
        fxOut[i * 2 + 1] = r;
        const aL = l < 0 ? -l : l;
        const aR = r < 0 ? -r : r;
        if (aL > peak) peak = aL;
        if (aR > peak) peak = aR;
        sumSq += l * l + r * r;
      }
      this.meters.push({
        channelId,
        peak,
        rms: Math.sqrt(sumSq / (blockSize * 2)),
      });

      if (channel.sendsTo.length === 0) {
        // Sink. By convention the last sink in channelOrder is master; its
        // post-FX/pan/vol audio is the worklet's output.
        outStereo.set(fxOut.subarray(0, blockSize * 2));
      } else {
        for (let s = 0; s < channel.sendsTo.length; s++) {
          const destId = channel.sendsTo[s]!;
          const lvl = channel.sendsLevels?.[s] ?? 1;
          const sendDest = this.getOrAllocBuffer(this.channelInputs, destId, blockSize);
          if (lvl === 1) {
            for (let i = 0; i < blockSize * 2; i++) sendDest[i]! += fxOut[i]!;
          } else {
            for (let i = 0; i < blockSize * 2; i++) sendDest[i]! += fxOut[i]! * lvl;
          }
        }
      }
    }

    return this.meters;
  }

  private zeroChannelInputs(blockSize: number): void {
    for (const buf of this.channelInputs.values()) buf.fill(0, 0, blockSize * 2);
  }

  private getOrAllocBuffer(
    map: Map<string, Float32Array>,
    key: string,
    blockSize: number,
  ): Float32Array {
    let buf = map.get(key);
    if (!buf) {
      buf = new Float32Array(this.maxBlockSize * 2);
      map.set(key, buf);
    }
    return buf;
  }
}
