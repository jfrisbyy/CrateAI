// The export bundle's contents: which storage objects go in under which
// names, and the manifest.json that describes them. Pure, so the route
// stays thin and this can be tested without storage.

export interface BundleFileInfo {
  id: string;
  name: string;
  bpm: number | null;
  key: { tonic: string; mode: string } | null;
}

export interface BundleChopInput {
  index: number;
  name: string | null;
  start_s: number;
  end_s: number;
  /** null when the chop's file is gone (skipped, listed in `skipped`) */
  file: { original_filename: string; storage_path: string } | null;
}

export interface BundleMidiInput {
  kind: string;
  storage_path: string;
}

export interface ManifestChop {
  index: number;
  name: string;
  filename: string;
  start_s: number;
  end_s: number;
}

export interface ManifestMidi {
  kind: string;
  filename: string;
}

export interface BundleManifest {
  file: BundleFileInfo;
  chops: ManifestChop[];
  midi: ManifestMidi[];
  generated_at: string;
}

export interface BundleEntry {
  /** path inside the zip */
  zip_path: string;
  storage_path: string;
}

export interface BundlePlan {
  manifest: BundleManifest;
  entries: BundleEntry[];
  /** chop indexes whose file row was missing */
  skipped_chops: number[];
}

/** Keep letters, digits, dot, dash, underscore and #; everything else becomes a dash. */
export function safeFilename(name: string, fallback = "file"): string {
  const base = name.split("/").pop() ?? name;
  const safe = base.replace(/[^A-Za-z0-9._#-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || fallback;
}

/** `name.ext` -> `name-2.ext`, `name-3.ext`, ... until unique. */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  const taken = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    let candidate = name;
    let n = seen.get(name) ?? 1;
    while (taken.has(candidate)) {
      n += 1;
      const dot = name.lastIndexOf(".");
      candidate = dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
    }
    seen.set(name, n);
    taken.add(candidate);
    out.push(candidate);
  }
  return out;
}

export function basenameOf(storagePath: string): string {
  return storagePath.split("/").pop() ?? storagePath;
}

export function planBundle(file: BundleFileInfo, chops: BundleChopInput[], midi: BundleMidiInput[], generatedAt: string): BundlePlan {
  const withFiles = [...chops].sort((a, b) => a.index - b.index);
  const kept = withFiles.filter((c) => c.file !== null);
  const chopNames = uniqueNames(kept.map((c) => safeFilename(c.file!.original_filename, `chop-${c.index + 1}.wav`)));
  const midiNames = uniqueNames(midi.map((m) => safeFilename(basenameOf(m.storage_path), `${m.kind}.mid`)));
  const entries: BundleEntry[] = [];
  const manifestChops: ManifestChop[] = kept.map((c, i) => {
    const filename = `chops/${chopNames[i]}`;
    entries.push({ zip_path: filename, storage_path: c.file!.storage_path });
    return { index: c.index, name: c.name?.trim() || `chop ${c.index + 1}`, filename, start_s: c.start_s, end_s: c.end_s };
  });
  const manifestMidi: ManifestMidi[] = midi.map((m, i) => {
    const filename = `midi/${midiNames[i]}`;
    entries.push({ zip_path: filename, storage_path: m.storage_path });
    return { kind: m.kind, filename };
  });
  return {
    manifest: { file, chops: manifestChops, midi: manifestMidi, generated_at: generatedAt },
    entries,
    skipped_chops: withFiles.filter((c) => c.file === null).map((c) => c.index),
  };
}

/** `Song_kit.zip` from the source file's name. */
export function bundleFilename(originalFilename: string): string {
  const dot = originalFilename.lastIndexOf(".");
  const stem = dot > 0 ? originalFilename.slice(0, dot) : originalFilename;
  return `${safeFilename(stem, "kit")}_kit.zip`;
}
