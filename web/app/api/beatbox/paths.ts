// Recording names and paths for the beatbox routes: library/{user_id}/beatbox/{safe name}.

export function safeRecordingName(name: string): string | null {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = lower.slice(dot + 1);
  if (ext !== "wav" && ext !== "webm") return null;
  const base = lower
    .slice(0, dot)
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  if (!base) return null;
  return `${base}.${ext}`;
}

export function recordingPath(userId: string, safeName: string): string {
  return `library/${userId}/beatbox/${safeName}`;
}

/** A path the caller uploaded through /api/beatbox/upload-url (compute checks the same prefix). */
export function ownRecordingPath(path: string, userId: string): boolean {
  return path.startsWith(`library/${userId}/beatbox/`) && !path.includes("..") && !path.includes("//");
}
