// 16-bit PCM WAV in the browser. MediaRecorder gives webm/opus everywhere and
// `audio/wav` nowhere (`MediaRecorder.isTypeSupported("audio/wav")` is false
// in every engine), so a recording is decoded with the AudioContext and
// written as WAV before upload: libsndfile on the compute side reads it
// without ffmpeg, which the local runner may not have. Pure functions here;
// `blobToWav` takes the decoder so it runs in tests without a DOM.

export interface PcmLike {
  numberOfChannels: number;
  sampleRate: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

const HEADER_BYTES = 44;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Interleave `channels` (equal length) into a canonical 44-byte-header PCM16 WAV. Samples are clipped to [-1, 1]. */
export function encodeWav16(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  if (channels.length === 0) throw new Error("encodeWav16 needs at least one channel");
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("encodeWav16 needs a positive sample rate");
  const frames = Math.min(...channels.map((c) => c.length));
  const numChannels = channels.length;
  const blockAlign = numChannels * 2;
  const dataBytes = frames * blockAlign;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, Math.round(sampleRate), true);
  view.setUint32(28, Math.round(sampleRate) * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = HEADER_BYTES;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c]![i] ?? 0));
      view.setInt16(offset, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
      offset += 2;
    }
  }
  return buffer;
}

export interface DecodedWav {
  sampleRate: number;
  channels: Float32Array[];
}

/** Read back a PCM16 WAV written by `encodeWav16` (or any canonical 16-bit PCM file). */
export function decodeWav16(buffer: ArrayBuffer): DecodedWav {
  const view = new DataView(buffer);
  const tag = (o: number) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  let offset = 12;
  let numChannels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataStart = -1;
  let dataBytes = 0;
  while (offset + 8 <= view.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      const format = view.getUint16(offset + 8, true);
      if (format !== 1) throw new Error(`unsupported WAV format ${format}`);
      numChannels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bits = view.getUint16(offset + 22, true);
    } else if (id === "data") {
      dataStart = offset + 8;
      dataBytes = Math.min(size, view.byteLength - dataStart);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataStart < 0 || numChannels === 0) throw new Error("WAV has no fmt or data chunk");
  if (bits !== 16) throw new Error(`unsupported bit depth ${bits}`);
  const frames = Math.floor(dataBytes / (numChannels * 2));
  const channels = Array.from({ length: numChannels }, () => new Float32Array(frames));
  let p = dataStart;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const v = view.getInt16(p, true);
      channels[c]![i] = v < 0 ? v / 32768 : v / 32767;
      p += 2;
    }
  }
  return { sampleRate, channels };
}

/** Equal-weight mono mixdown. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0]!;
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i]! += ch[i]! / channels.length;
  return out;
}

export function channelsOfPcm(pcm: PcmLike): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < pcm.numberOfChannels; c++) out.push(pcm.getChannelData(c));
  return out;
}

/**
 * A recorded blob (webm/opus, ogg, mp4) to a mono PCM16 WAV blob. `decode`
 * is `(bytes) => audioContext.decodeAudioData(bytes)` in the browser.
 */
export async function blobToWav(blob: Blob, decode: (bytes: ArrayBuffer) => Promise<PcmLike>): Promise<Blob> {
  const bytes = await blob.arrayBuffer();
  const pcm = await decode(bytes);
  const mono = mixToMono(channelsOfPcm(pcm));
  return new Blob([encodeWav16([mono], pcm.sampleRate)], { type: "audio/wav" });
}

/** The duration a WAV blob will carry, without decoding it (for the UI line after conversion). */
export function wavDurationS(byteLength: number, sampleRate: number, channels = 1): number {
  return Math.max(0, byteLength - HEADER_BYTES) / (sampleRate * channels * 2);
}
