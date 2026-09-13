// The double's own tests. If these are wrong every route test that leans on
// them is wrong, so the boundary rules (RLS, uniqueness, PostgREST shapes,
// storage policies) are asserted here directly.

import { beforeEach, describe, expect, it } from "vitest";
import { TestDb } from "./db";
import { seedFile, seedJob } from "./rows";
import { anonClient, serviceClient, sessionClient } from "./supabase";
import { USER_A, USER_B } from "./world";

let db: TestDb;

beforeEach(() => {
  db = new TestDb();
});

describe("row level security", () => {
  it("shows a user only their own rows", async () => {
    seedFile(db, USER_A, { original_filename: "mine.wav" });
    seedFile(db, USER_B, { original_filename: "theirs.wav" });

    const { data } = await sessionClient(db, USER_A).asServerClient().from("files").select("*");
    expect(data?.map((f) => f.original_filename)).toEqual(["mine.wav"]);
  });

  it("hides another user's row behind maybeSingle (no data, no error)", async () => {
    const theirs = seedFile(db, USER_B);
    const { data, error } = await sessionClient(db, USER_A).asServerClient().from("files").select("*").eq("id", theirs.id).maybeSingle();
    expect(data).toBeNull();
    expect(error).toBeNull();
  });

  it("refuses an insert that claims another user's id", async () => {
    const { error } = await sessionClient(db, USER_A)
      .asServerClient()
      .from("jobs")
      .insert({ user_id: USER_B, kind: "analyze", status: "queued", params: {} });
    expect(error?.code).toBe("42501");
    expect(db.rows("jobs")).toHaveLength(0);
  });

  it("updates and deletes nothing across the boundary", async () => {
    const theirs = seedFile(db, USER_B, { title: "theirs" });
    const client = sessionClient(db, USER_A).asServerClient();
    const updated = await client.from("files").update({ title: "mine now" }).eq("id", theirs.id).select("*");
    expect(updated.data).toEqual([]);
    const deleted = await client.from("files").delete({ count: "exact" }).eq("id", theirs.id);
    expect(deleted.count).toBe(0);
    expect(db.find("files", theirs.id)?.title).toBe("theirs");
  });

  it("lets the service role cross the boundary", async () => {
    seedFile(db, USER_B);
    const { data } = await serviceClient(db).asServerClient().from("files").select("*");
    expect(data).toHaveLength(1);
  });

  it("sees nothing with no session", async () => {
    seedFile(db, USER_A);
    const { data } = await anonClient(db).asServerClient().from("files").select("*");
    expect(data).toEqual([]);
    const { data: user, error } = await anonClient(db).asServerClient().auth.getUser();
    expect(user.user).toBeNull();
    expect(error).not.toBeNull();
  });

  it("refuses a plan change from the user's own client (profiles WITH CHECK)", async () => {
    db.seed("profiles", { id: USER_A, plan: "free", plan_status: "active" });
    const client = sessionClient(db, USER_A).asServerClient();
    const denied = await client.from("profiles").update({ plan: "pro" }).eq("id", USER_A).select("*");
    expect(denied.error?.code).toBe("42501");
    const allowed = await client.from("profiles").update({ corrections_opt_in: true }).eq("id", USER_A).select("*").single();
    expect(allowed.data?.corrections_opt_in).toBe(true);
  });
});

describe("postgrest shapes", () => {
  it("single() on no rows is PGRST116", async () => {
    const { data, error } = await sessionClient(db, USER_A).asServerClient().from("files").select("*").eq("id", USER_B).single();
    expect(data).toBeNull();
    expect(error?.code).toBe("PGRST116");
  });

  it("projects the selected columns and nothing else", async () => {
    const file = seedFile(db, USER_A);
    const { data } = await sessionClient(db, USER_A).asServerClient().from("files").select("id, status").eq("id", file.id).single();
    expect(Object.keys(data ?? {})).toEqual(["id", "status"]);
  });

  it("counts with head", async () => {
    seedJob(db, USER_A);
    seedJob(db, USER_A);
    const { data, count } = await sessionClient(db, USER_A).asServerClient().from("jobs").select("id", { count: "exact", head: true });
    expect(data).toBeNull();
    expect(count).toBe(2);
  });

  it("orders, puts nulls last ascending, and limits", async () => {
    const file = seedFile(db, USER_A);
    db.seed("loops", { user_id: USER_A, file_id: file.id, start_s: 1, end_s: 2, score: null });
    db.seed("loops", { user_id: USER_A, file_id: file.id, start_s: 3, end_s: 4, score: 0.9 });
    const { data } = await sessionClient(db, USER_A)
      .asServerClient()
      .from("loops")
      .select("*")
      .order("score", { ascending: false, nullsFirst: false })
      .limit(1);
    expect(data?.[0]?.score).toBe(0.9);
  });

  it("reports a unique violation as 23505", async () => {
    const file = seedFile(db, USER_A);
    const { error } = await sessionClient(db, USER_A)
      .asServerClient()
      .from("files")
      .insert({ user_id: USER_A, sha256: file.sha256, original_filename: "again.wav", storage_path: "library/x/y.wav" });
    expect(error?.code).toBe("23505");
  });

  it("applies column defaults on insert", async () => {
    const { data } = await sessionClient(db, USER_A)
      .asServerClient()
      .from("jobs")
      .insert({ user_id: USER_A, kind: "analyze" })
      .select("*")
      .single();
    expect(data?.status).toBe("queued");
    expect(data?.params).toEqual({});
    expect(data?.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("storage policies", () => {
  it("signs a URL for the caller's own object only", async () => {
    const mine = seedFile(db, USER_A);
    const theirs = seedFile(db, USER_B);
    const client = sessionClient(db, USER_A).asServerClient();
    const okUrl = await client.storage.from("audio").createSignedUrl(mine.storage_path, 600);
    expect(okUrl.data?.signedUrl).toContain(mine.storage_path);
    const denied = await client.storage.from("audio").createSignedUrl(theirs.storage_path, 600);
    expect(denied.error?.message).toBe("Object not found");
    expect(denied.data).toBeNull();
  });

  it("refuses a write outside library/{uid}/ and allows the service role", async () => {
    const client = sessionClient(db, USER_A).asServerClient();
    const denied = await client.storage.from("audio").upload(`derived/${USER_A}/f/midi/x.mid`, "bytes");
    expect(denied.error).not.toBeNull();
    const allowed = await serviceClient(db).asServerClient().storage.from("audio").upload(`derived/${USER_A}/f/midi/x.mid`, "bytes");
    expect(allowed.error).toBeNull();
    expect(db.objects.has(`derived/${USER_A}/f/midi/x.mid`)).toBe(true);
  });

  it("refuses to download another user's object", async () => {
    const theirs = seedFile(db, USER_B);
    const { data, error } = await sessionClient(db, USER_A).asServerClient().storage.from("audio").download(theirs.storage_path);
    expect(data).toBeNull();
    expect(error?.message).toBe("Object not found");
  });

  it("lists one level at a time, folders without an id", async () => {
    db.putObject(`derived/${USER_A}/file/chops/000.wav`, "a");
    db.putObject(`derived/${USER_A}/file/report.json`, "b");
    const { data } = await sessionClient(db, USER_A).asServerClient().storage.from("audio").list(`derived/${USER_A}/file`);
    expect(data).toEqual([
      { name: "chops", id: null },
      { name: "report.json", id: "object-report.json" },
    ]);
  });
});

describe("rpc", () => {
  it("sums usage for the caller only", async () => {
    seedFile(db, USER_A, { size_bytes: 100 });
    seedFile(db, USER_B, { size_bytes: 999 });
    db.seed("usage_events", { user_id: USER_A, kind: "stem_job", amount: 2, created_at: "2026-09-13T00:00:00.000Z" });
    db.seed("usage_events", { user_id: USER_B, kind: "stem_job", amount: 5, created_at: "2026-09-13T00:00:00.000Z" });
    const { data } = await sessionClient(db, USER_A).asServerClient().rpc("usage_summary", { p_since: "2026-09-01T00:00:00.000Z" });
    expect(data).toEqual([
      { kind: "stem_job", total: 2 },
      { kind: "storage_bytes", total: 100 },
    ]);
  });

  it("errors on an unknown function", async () => {
    const client = sessionClient(db, USER_A).asServerClient() as unknown as {
      rpc: (name: string, args?: Record<string, unknown>) => Promise<{ error: { code: string } | null }>;
    };
    const { error } = await client.rpc("no_such_function", {});
    expect(error?.code).toBe("42883");
  });
});
