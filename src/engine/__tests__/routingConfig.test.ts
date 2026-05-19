import { describe, it, expect } from 'vitest';
import { buildRoutingConfig, topoSortChannels } from '../routingConfig';

describe('topoSortChannels', () => {
  it('places sources first, sinks last', () => {
    const channels = [
      { id: 'm0' },                       // sink (no sends)
      { id: 'm1', sends: ['m0'] },        // source
    ];
    expect(topoSortChannels(channels)).toEqual(['m1', 'm0']);
  });

  it('handles fan-out: one channel sends to many', () => {
    const channels = [
      { id: 'm1', sends: ['m0', 'mB'] },
      { id: 'mB', sends: ['m0'] },
      { id: 'm0' },
    ];
    const order = topoSortChannels(channels);
    // mB depends on m1; m0 depends on m1 and mB. m1 must precede mB; mB before m0.
    expect(order.indexOf('m1')).toBeLessThan(order.indexOf('mB'));
    expect(order.indexOf('mB')).toBeLessThan(order.indexOf('m0'));
  });

  it('handles fan-in: many channels send to one bus', () => {
    const channels = [
      { id: 'm1', sends: ['mB'] },
      { id: 'm2', sends: ['mB'] },
      { id: 'm3', sends: ['mB'] },
      { id: 'mB', sends: ['m0'] },
      { id: 'm0' },
    ];
    const order = topoSortChannels(channels);
    // Each source must precede mB; mB must precede m0.
    for (const src of ['m1', 'm2', 'm3']) {
      expect(order.indexOf(src)).toBeLessThan(order.indexOf('mB'));
    }
    expect(order.indexOf('mB')).toBeLessThan(order.indexOf('m0'));
  });

  it('appends cycle members at the end rather than infinite-looping', () => {
    const channels = [
      { id: 'a', sends: ['b'] },
      { id: 'b', sends: ['a'] },           // 2-cycle
      { id: 'c' },                          // standalone sink
    ];
    const order = topoSortChannels(channels);
    // 'c' has in-degree 0 → comes first. 'a' and 'b' are tail-appended (in
    // their original declaration order because neither in-deg reaches 0).
    expect(order).toEqual(['c', 'a', 'b']);
  });

  it('ignores send destinations that point at unknown channels', () => {
    const channels = [
      { id: 'm1', sends: ['mZZ', 'm0'] },   // mZZ doesn't exist; m0 does
      { id: 'm0' },
    ];
    expect(topoSortChannels(channels)).toEqual(['m1', 'm0']);
  });

  it('empty channel list returns empty order', () => {
    expect(topoSortChannels([])).toEqual([]);
  });
});

describe('buildRoutingConfig', () => {
  it('drops tracks without a generator', () => {
    const cfg = buildRoutingConfig(
      [
        { id: 't1', channel: 1, generator: { id: 'g' } },
        { id: 't2', channel: 2 },           // no generator
      ],
      [],
    );
    expect(cfg.tracks).toHaveLength(1);
    expect(cfg.tracks[0]!.id).toBe('t1');
  });

  it('maps track.channel to channelId mX', () => {
    const cfg = buildRoutingConfig(
      [{ id: 't1', channel: 3, generator: {} }],
      [],
    );
    expect(cfg.tracks[0]!.channelId).toBe('m3');
  });

  it('defaults track vol/mute/solo when omitted', () => {
    const cfg = buildRoutingConfig(
      [{ id: 't1', channel: 1, generator: {} }],
      [],
    );
    expect(cfg.tracks[0]).toMatchObject({ vol: 1, mute: false, solo: false });
  });

  it('passes track vol/mute/solo through when provided', () => {
    const cfg = buildRoutingConfig(
      [{ id: 't1', channel: 1, generator: {}, vol: 0.5, mute: true, solo: false }],
      [],
    );
    expect(cfg.tracks[0]).toMatchObject({ vol: 0.5, mute: true, solo: false });
  });

  it('threads channel sends into sendsTo + sendsLevels with defaults', () => {
    const cfg = buildRoutingConfig(
      [],
      [
        { id: 'm1', sends: ['m0', 'mB'], sendLevels: { m0: 0.8 /* mB missing */ } },
        { id: 'mB', sends: ['m0'] },
        { id: 'm0' },
      ],
    );
    const m1 = cfg.channels.find((c) => c.id === 'm1')!;
    expect(m1.sendsTo).toEqual(['m0', 'mB']);
    expect(m1.sendsLevels).toEqual([0.8, 1]); // mB defaults to 1
    expect(cfg.channels.find((c) => c.id === 'm0')!.sendsTo).toEqual([]);
  });

  it('defaults channel vol to 1 and pan to 0', () => {
    const cfg = buildRoutingConfig([], [{ id: 'm0' }]);
    const m0 = cfg.channels[0]!;
    expect(m0.vol).toBe(1);
    expect(m0.pan).toBe(0);
  });

  it('includes channelOrder in the returned config', () => {
    const cfg = buildRoutingConfig(
      [],
      [{ id: 'm1', sends: ['m0'] }, { id: 'm0' }],
    );
    expect(cfg.channelOrder).toEqual(['m1', 'm0']);
  });

  it('does not mutate input arrays', () => {
    const tracks = [{ id: 't1', channel: 1, generator: {} }];
    const channels = [{ id: 'm1', sends: ['m0'] }, { id: 'm0' }];
    const tracksCopy = JSON.parse(JSON.stringify(tracks));
    const channelsCopy = JSON.parse(JSON.stringify(channels));
    buildRoutingConfig(tracks, channels);
    expect(tracks).toEqual(tracksCopy);
    expect(channels).toEqual(channelsCopy);
  });
});
