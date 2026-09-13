// Collecting audio files from a drop (files and folders) or a picker.
// Folder drops use webkitGetAsEntry and walk directories; the picker uses
// `webkitdirectory`. Only audio extensions pass (OPEN_QUESTIONS B.10).

export const AUDIO_EXTENSIONS = ["wav", "aif", "aiff", "flac", "mp3", "m4a", "aac", "ogg", "oga", "opus"] as const;
export type AudioExtension = (typeof AUDIO_EXTENSIONS)[number];

export const ACCEPT_ATTR = AUDIO_EXTENSIONS.map((e) => `.${e}`).join(",");

const CONTENT_TYPES: Record<AudioExtension, string> = {
  wav: "audio/wav",
  aif: "audio/aiff",
  aiff: "audio/aiff",
  flac: "audio/flac",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
};

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

export function isAudioExtension(ext: string): ext is AudioExtension {
  return (AUDIO_EXTENSIONS as readonly string[]).includes(ext);
}

export function isAudioFile(file: File): boolean {
  return isAudioExtension(extensionOf(file.name));
}

/** A content type we trust; browsers leave `file.type` empty for AIFF and FLAC. */
export function contentTypeFor(file: File): string {
  const ext = extensionOf(file.name);
  if (isAudioExtension(ext)) return CONTENT_TYPES[ext];
  return file.type || "application/octet-stream";
}

export interface PickedFile {
  file: File;
  /** path inside the dropped folder, "" for loose files */
  relativePath: string;
}

type Entry = FileSystemEntry & {
  isFile: boolean;
  isDirectory: boolean;
  fullPath: string;
};
type FileEntry = Entry & { file: (ok: (f: File) => void, err: (e: unknown) => void) => void };
type DirectoryEntry = Entry & { createReader: () => { readEntries: (ok: (es: Entry[]) => void, err: (e: unknown) => void) => void } };

function readAllEntries(dir: DirectoryEntry): Promise<Entry[]> {
  const reader = dir.createReader();
  const all: Entry[] = [];
  return new Promise((resolve, reject) => {
    const step = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        step(); // readEntries returns at most ~100 entries per call
      }, reject);
    };
    step();
  });
}

function fileFromEntry(entry: FileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walk(entry: Entry, base: string, out: PickedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await fileFromEntry(entry as FileEntry);
    if (isAudioFile(file)) out.push({ file, relativePath: base });
    return;
  }
  if (entry.isDirectory) {
    const children = await readAllEntries(entry as DirectoryEntry);
    const path = base ? `${base}/${entry.name}` : entry.name;
    for (const child of children) await walk(child, path, out);
  }
}

/** Files (and the audio files inside folders) from a drop event. */
export async function filesFromDrop(dataTransfer: DataTransfer): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  const items = Array.from(dataTransfer.items ?? []);
  const entries = items
    .filter((item) => item.kind === "file")
    .map((item) => (typeof item.webkitGetAsEntry === "function" ? (item.webkitGetAsEntry() as Entry | null) : null));

  if (entries.some((e) => e !== null)) {
    for (const entry of entries) {
      if (entry) await walk(entry, "", out);
    }
    return out;
  }
  // No entry API (older engines): plain files only.
  for (const file of Array.from(dataTransfer.files ?? [])) {
    if (isAudioFile(file)) out.push({ file, relativePath: "" });
  }
  return out;
}

/** Files from an <input type="file"> (with or without webkitdirectory). */
export function filesFromInput(list: FileList | null): PickedFile[] {
  if (!list) return [];
  const out: PickedFile[] = [];
  for (const file of Array.from(list)) {
    if (!isAudioFile(file)) continue;
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    out.push({ file, relativePath: dir });
  }
  return out;
}
