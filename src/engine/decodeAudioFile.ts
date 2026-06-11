/**
 * Decode an encoded audio file (wav/mp3/ogg/flac — whatever the browser
 * supports) into interleaved Float32 PCM at the engine's sample rate. Browser-
 * only (uses AudioContext / OfflineAudioContext); verified by manual smoke test.
 *
 * Resampling to the engine rate happens at decode time via an OfflineAudioContext
 * so the worklet's playback cursor stays a trivial integer advance. Output is
 * capped at stereo (2 channels).
 */
export interface DecodedAudio {
  pcm: Float32Array;
  channels: number;
  frames: number;
  sampleRate: number;
}

export async function decodeAudioFile(
  arrayBuffer: ArrayBuffer,
  targetSampleRate: number,
): Promise<DecodedAudio> {
  // decodeAudioData may detach its input, so decode from a copy.
  const tmp = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await tmp.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    void tmp.close();
  }

  let buf = decoded;
  if (decoded.sampleRate !== targetSampleRate) {
    const outFrames = Math.max(1, Math.ceil(decoded.duration * targetSampleRate));
    const off = new OfflineAudioContext(decoded.numberOfChannels, outFrames, targetSampleRate);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    buf = await off.startRendering();
  }

  const channels = Math.min(2, buf.numberOfChannels);
  const frames = buf.length;
  const pcm = new Float32Array(frames * channels);
  const chans: Float32Array[] = [];
  for (let c = 0; c < channels; c++) chans.push(buf.getChannelData(c));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) pcm[f * channels + c] = chans[c]![f]!;
  }
  return { pcm, channels, frames, sampleRate: targetSampleRate };
}
