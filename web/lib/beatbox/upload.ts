// A recording to Storage: convert to 16-bit WAV in the browser (so the
// compute reads it with libsndfile, no ffmpeg needed), ask the route for a
// signed upload URL under library/{user}/beatbox/, upload.

import { beatboxApi } from "@/lib/api/beatbox";
import { getAudioContext } from "@/lib/audio/decode";
import { blobToWav, wavDurationS } from "./wav";

export interface UploadedRecording {
  storage_path: string;
  format: "wav" | "webm";
  bytes: number;
  duration_s: number | null;
}

function baseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "take";
}

/**
 * Upload a MediaRecorder blob. WAV when the browser can decode its own
 * recording (it can); otherwise the webm goes up as recorded and the compute
 * decodes it with ffmpeg.
 */
export async function uploadRecording(blob: Blob, name: string, convertToWav = true): Promise<UploadedRecording> {
  let body = blob;
  let format: "wav" | "webm" = "webm";
  let sampleRate: number | null = null;
  if (convertToWav) {
    try {
      const ctx = getAudioContext();
      body = await blobToWav(blob, async (bytes) => {
        const decoded = await ctx.decodeAudioData(bytes);
        sampleRate = decoded.sampleRate;
        return decoded;
      });
      format = "wav";
    } catch (err) {
      if (!/webm/i.test(blob.type)) {
        throw new Error(`Could not convert the recording to WAV (${err instanceof Error ? err.message : String(err)}), and this browser did not record webm.`);
      }
      body = blob;
      format = "webm";
    }
  } else if (!/webm/i.test(blob.type)) {
    throw new Error("The recording is not webm; enable the WAV conversion.");
  }
  const target = await beatboxApi.uploadUrl({ name: `${baseName(name)}.${format}` });
  await beatboxApi.uploadToSigned(target, body);
  return {
    storage_path: target.storage_path,
    format,
    bytes: body.size,
    duration_s: format === "wav" && sampleRate ? wavDurationS(body.size, sampleRate) : null,
  };
}
