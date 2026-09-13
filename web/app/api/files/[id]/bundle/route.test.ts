import { unzipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, get, params, seedChop, seedFile, seedMidi, USER_A, USER_B, type World } from "@/lib/testing";
import { MANIFEST_NAME } from "@/lib/midi/bundle";
import { GET } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

/** A file with two chops (each with its WAV) and one .mid: the shape the kit export expects. */
function seedKit(userId: string) {
  const file = seedFile(world.db, userId, { original_filename: "song.wav" });
  const chopFiles = [0, 1].map((i) =>
    seedFile(world.db, userId, {
      kind: "chop",
      original_filename: `chop-00${i + 1}.wav`,
      storage_path: `derived/${userId}/${file.id}/chops/00${i}.wav`,
      size_bytes: 128,
      bytes: `wav-${i}`,
    }),
  );
  chopFiles.forEach((chopFile, i) => seedChop(world.db, userId, file.id, { index: i, chop_file_id: chopFile.id }));
  const midi = seedMidi(world.db, userId, file.id);
  return { file, chopFiles, midi };
}

describe("GET /api/files/[id]/bundle", () => {
  it("zips the chops, the MIDI and a manifest", async () => {
    const { file } = seedKit(USER_A);
    const res = await GET(get(`/api/files/${file.id}/bundle`), params({ id: file.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="song_kit.zip"');
    const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual(["chops/chop-001.wav", "chops/chop-002.wav", MANIFEST_NAME, "midi/drums.mid"]);
    expect(new TextDecoder().decode(entries["chops/chop-001.wav"])).toBe("wav-0");
  });

  it("409s when there is nothing to bundle", async () => {
    const file = seedFile(world.db, USER_A);
    const { status } = await call(GET(get(`/api/files/${file.id}/bundle`), params({ id: file.id })));
    expect(status).toBe(409);
  });

  it("413s before fetching anything when the stored sizes pass the 200 MB cap", async () => {
    const { file, chopFiles } = seedKit(USER_A);
    world.db.find("files", chopFiles[0]!.id)!.size_bytes = 201 * 1024 * 1024;
    const { status, body } = await call<{ error: string }>(GET(get(`/api/files/${file.id}/bundle`), params({ id: file.id })));
    expect(status).toBe(413);
    expect(body.error).toContain("200 MB");
  });

  it("404s another user's file", async () => {
    const { file } = seedKit(USER_B);
    const { status } = await call(GET(get(`/api/files/${file.id}/bundle`), params({ id: file.id })));
    expect(status).toBe(404);
  });

  it("never serves bytes from another user's storage prefix", async () => {
    // A files row is the caller's, but its storage_path points at user B's
    // audio. Only the storage policies stop this, so the route has to fetch
    // as the caller, not with the service role.
    const victim = seedFile(world.db, USER_B, { storage_path: `library/${USER_B}/ab/secret.wav`, bytes: "user-b-audio" });
    const file = seedFile(world.db, USER_A, { original_filename: "song.wav" });
    const pointer = seedFile(world.db, USER_A, {
      kind: "chop",
      original_filename: "stolen.wav",
      storage_path: victim.storage_path,
      size_bytes: 12,
      withObject: false,
    });
    seedChop(world.db, USER_A, file.id, { index: 0, chop_file_id: pointer.id });

    const res = await GET(get(`/api/files/${file.id}/bundle`), params({ id: file.id }));
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain("user-b-audio");
  });

  it("400s a malformed id", async () => {
    const { status } = await call(GET(get("/api/files/x/bundle"), params({ id: "x" })));
    expect(status).toBe(400);
  });

  it("401s with no session", async () => {
    const { file } = seedKit(USER_A);
    world.signOut();
    expect((await GET(get(`/api/files/${file.id}/bundle`), params({ id: file.id }))).status).toBe(401);
  });
});
