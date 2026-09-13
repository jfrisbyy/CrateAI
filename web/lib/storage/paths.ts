// Storage layout (docs/CONTRACTS.md section 2). Bucket `audio`, private.

export const AUDIO_BUCKET = "audio";
export const SIGNED_URL_TTL_S = 600;

export const SHA256_RE = /^[0-9a-f]{64}$/;

/** library/{user_id}/{sha256[:2]}/{sha256}.{ext} */
export function libraryPath(userId: string, sha256: string, ext: string): string {
  return `library/${userId}/${sha256.slice(0, 2)}/${sha256}.${ext}`;
}

/** derived/{user_id}/{file_id}/ — everything compute writes for a file */
export function derivedPrefix(userId: string, fileId: string): string {
  return `derived/${userId}/${fileId}`;
}

export function extensionOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i < 0 ? "" : filename.slice(i + 1).toLowerCase();
}
