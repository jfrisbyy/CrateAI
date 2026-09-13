// The kit zip, built in memory with fflate. WAVs are stored (level 0: PCM
// barely deflates and a kit should open instantly); the .mid files and the
// manifest are deflated. The cap keeps a route from holding more than
// BUNDLE_CAP_BYTES of audio at once.

import { strToU8, zipSync, type Zippable } from "fflate";
import type { BundleManifest } from "./manifest";

export const BUNDLE_CAP_BYTES = 200 * 1024 * 1024;
export const MANIFEST_NAME = "manifest.json";

export class BundleTooLargeError extends Error {
  constructor(public readonly bytes: number) {
    super(`The bundle would be ${Math.round(bytes / (1024 * 1024))} MB; the cap is ${BUNDLE_CAP_BYTES / (1024 * 1024)} MB.`);
    this.name = "BundleTooLargeError";
  }
}

export interface BundleInputFile {
  zip_path: string;
  bytes: Uint8Array;
}

/** Sum the sizes and throw once the cap is crossed (call as each object arrives). */
export function assertUnderCap(totalBytes: number): void {
  if (totalBytes > BUNDLE_CAP_BYTES) throw new BundleTooLargeError(totalBytes);
}

export function buildBundleZip(files: BundleInputFile[], manifest: BundleManifest): Uint8Array<ArrayBuffer> {
  let total = 0;
  const data: Zippable = {};
  for (const f of files) {
    total += f.bytes.byteLength;
    assertUnderCap(total);
    const stored = f.zip_path.toLowerCase().endsWith(".wav");
    data[f.zip_path] = stored ? [f.bytes, { level: 0 }] : f.bytes;
  }
  data[MANIFEST_NAME] = strToU8(JSON.stringify(manifest, null, 2));
  // fflate allocates a fresh ArrayBuffer; its typings say ArrayBufferLike, Response wants ArrayBuffer.
  return zipSync(data, { level: 6 }) as Uint8Array<ArrayBuffer>;
}
