// GET /api/files/[id]/bundle — the kit: every chop WAV, every .mid for the
// file, and manifest.json, zipped in memory (fflate) and sent as one body.
// Objects are fetched with the caller's own client: RLS lets a user read
// library/{their id}/ and derived/{their id}/, and the storage policy is what
// keeps a row whose storage_path was written by hand from reaching another
// user's audio. Over BUNDLE_CAP_BYTES of audio answers 413.

import { dbError, handle, HttpError, requireUser, requireUuid } from "@/lib/http";
import { assertUnderCap, buildBundleZip, BundleTooLargeError, type BundleInputFile } from "@/lib/midi/bundle";
import { bundleFilename, planBundle, type BundleChopInput } from "@/lib/midi/manifest";
import { vitalsOf } from "@/lib/api/stems";
import { AUDIO_BUCKET } from "@/lib/storage/paths";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const id = requireUuid((await ctx.params).id, "file id");

    const { data: file, error } = await supabase.from("files").select("id, original_filename, report").eq("id", id).maybeSingle();
    if (error) throw dbError(error, "Loading the file");
    if (!file) throw new HttpError(404, "File not found.");

    const chops = await supabase.from("chops").select("*").eq("source_file_id", id).order("index", { ascending: true }).limit(1000);
    if (chops.error) throw dbError(chops.error, "Listing chops");
    const midi = await supabase.from("midi").select("kind, storage_path").eq("source_file_id", id).order("created_at", { ascending: true }).limit(200);
    if (midi.error) throw dbError(midi.error, "Listing MIDI");

    const chopFileIds = chops.data.map((c) => c.chop_file_id).filter((v): v is string => v !== null);
    const chopFiles = new Map<string, { original_filename: string; storage_path: string; size_bytes: number | null }>();
    if (chopFileIds.length > 0) {
      const files = await supabase.from("files").select("id, original_filename, storage_path, size_bytes").in("id", chopFileIds);
      if (files.error) throw dbError(files.error, "Loading the chop files");
      for (const f of files.data) chopFiles.set(f.id, f);
    }

    const chopInputs: BundleChopInput[] = chops.data.map((c) => {
      const f = c.chop_file_id ? chopFiles.get(c.chop_file_id) : undefined;
      return { index: c.index, name: c.name, start_s: c.start_s, end_s: c.end_s, file: f ? { original_filename: f.original_filename, storage_path: f.storage_path } : null };
    });
    const vitals = vitalsOf(file.report);
    const plan = planBundle(
      { id: file.id, name: file.original_filename, bpm: vitals?.bpm ?? null, key: vitals?.key ?? null },
      chopInputs,
      midi.data,
      new Date().toISOString(),
    );
    if (plan.entries.length === 0) throw new HttpError(409, "Nothing to bundle yet: chop the file or save some MIDI first.");

    // Refuse early from the stored sizes before fetching anything.
    let known = 0;
    for (const f of chopFiles.values()) known += f.size_bytes ?? 0;
    try {
      assertUnderCap(known);
    } catch (err) {
      if (err instanceof BundleTooLargeError) throw new HttpError(413, err.message);
      throw err;
    }

    const storage = supabase.storage.from(AUDIO_BUCKET);
    const files: BundleInputFile[] = [];
    let total = 0;
    for (const entry of plan.entries) {
      const downloaded = await storage.download(entry.storage_path);
      if (downloaded.error || !downloaded.data) {
        throw new HttpError(502, `Could not fetch ${entry.zip_path}: ${downloaded.error?.message ?? "no data"}`);
      }
      const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
      total += bytes.byteLength;
      try {
        assertUnderCap(total);
      } catch (err) {
        if (err instanceof BundleTooLargeError) throw new HttpError(413, err.message);
        throw err;
      }
      files.push({ zip_path: entry.zip_path, bytes });
    }

    const zip = buildBundleZip(files, plan.manifest);
    return new Response(zip, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-length": String(zip.byteLength),
        "content-disposition": `attachment; filename="${bundleFilename(file.original_filename)}"`,
        "cache-control": "private, no-store",
      },
    });
  });
}
