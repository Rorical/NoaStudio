/**
 * FNV-1a 32-bit hash of a channel id string. Mirrored in audio-worklet.ts so
 * the main thread can look up which channel a meter frame refers to without
 * threading the variable-length string through the meter ring.
 */
export function channelHash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
