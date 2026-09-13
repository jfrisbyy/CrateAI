# HANDOFF_route_tests.md

The route-level test layer for `web/app/api/**`: a Supabase client double, a
colocated test per route handler, and the fixes the tests found. Every one of
the 52 route files now has a `route.test.ts` next to it.

Verification in this worktree (`cd web`):

| Check | Result |
|---|---|
| `pnpm test` | 97 files, 710 tests passed (was 44 files, 376 tests) |
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| `pnpm build` | clean; every API route still compiles as dynamic |

315 of those tests are route tests; 19 more test the double itself.

## Files

```
web/lib/testing/                      the Supabase double and the route harness (new)
  schema.ts        per-table metadata mirroring supabase/migrations: owner column, whether an
                   insert policy exists, unique constraints, column defaults, frozen columns
  db.ts            TestDb: rows, storage objects, RPC dispatch; the storage bucket policies as
                   predicates; usage_summary / library_filter ported from the SQL
  supabase.ts      the client: PostgREST query builder, auth surface, storage, rpc.
                   sessionClient() = anon key under RLS, serviceClient() = service role
  rows.ts          seed helpers (file, job, loop, stem, chop, midi, layer, lane, revoice,
                   breakdown, comparison, conversation, message, profile, usage event, beatbox
                   profile) plus sampleReport()
  world.ts         createWorld(): fresh db, who is signed in, whether a service-role key and a
                   compute URL exist, a stubbed global fetch that answers the dispatcher
  http.ts          get/post/patch/del/rawPost builders, params(), call(), ndjson()
  setup.ts         vitest setupFile: points @/lib/supabase/server and /admin at the active world
  serverOnly.ts    empty module the `server-only` marker resolves to under vitest
  index.ts         one import for a test
  supabase.test.ts the double's own tests (RLS, PostgREST shapes, storage policies, RPC)
web/app/api/**/route.test.ts          52 files, one per route handler (new)
web/vitest.config.ts                  include app tests, alias server-only, add the setup file
docs/HANDOFF_route_tests.md           this file
```

`web/vitest.config.ts` is the one file touched outside this seam's ownership:
without the `app/**/*.test.ts` include the route tests never run, without the
`server-only` alias any route importing `lib/compute/dispatch` throws on
import, and without `setupFiles` every test file would have to repeat the same
two `vi.mock` calls. The change is additive; existing tests are unaffected.

## How a route test runs

The handler is imported and called the way Next calls it — a `Request` (or
`NextRequest`) and, for dynamic segments, `{ params: Promise<...> }`. Nothing
is mocked inside the handler: `requireUser()`, `dispatchJob()`, the quota
checks, `lib/webinfo`, `lib/narration` and `lib/search` all run for real. Only
the two Supabase entry points and the outbound `fetch` are doubles.

```ts
let world: World;
beforeEach(() => { world = createWorld(); });          // signed in as USER_A

it("404s another user's file", async () => {
  const theirs = seedFile(world.db, USER_B);
  const res = await GET(get(`/api/files/${theirs.id}`), params({ id: theirs.id }));
  expect(res.status).toBe(404);
});
```

`/api/chat` is the one route that also mocks `@/lib/anthropic/client`, because
the model client has no injection seam; the scripted model comes from the
existing `lib/chat/fakes.ts`.

## What the double can simulate

- **RLS exactly as the migration writes it.** Every table's owner column from
  `schema.ts`; a session client sees, updates and deletes only rows whose owner
  is the signed-in user, and an insert claiming another user's id fails with
  `42501`. `profiles` is keyed on `id`, has no insert policy, and its
  `WITH CHECK` freeze on `plan` is modelled, so a user cannot upgrade
  themselves. `usage_events` is select-only; `takedowns` and `web_cache` have
  no policy at all and are invisible to a session client.
- **The service role as a separate client** with no RLS and no storage policy,
  handed out only through the mocked `tryAdminClient()`/`createAdminClient()`
  and only when the world has a service-role key. This is what makes "the
  wrong client" a visible test failure rather than a silent success.
- **PostgREST result shapes**: `{ data, error }`, `PGRST116` from `single()`
  when the row count is not one, `maybeSingle()` returning `null` with no
  error, `{ count: "exact", head: true }`, `delete({ count: "exact" })`,
  column projection (a column you did not select really is absent), ordering
  with `nullsFirst`, `limit`, and `eq/neq/in/is/not/gt/gte/lt/lte`.
- **Unique constraints** (`23505`), so the "completed twice" path in
  `/api/files/complete` is exercised for real, and column defaults on insert.
- **Storage**: objects keyed by path, the bucket policies from the init
  migration (read where the second path segment is the caller, write only
  under `library/{uid}/`), `createSignedUrl(s)`, `createSignedUploadUrl`,
  `upload` (409 on an existing object), `download`, `remove`, and `list` one
  level at a time with folders carrying a null id.
- **RPCs**: `usage_summary` and `library_filter` ported from the SQL, including
  the `user_edits` fallbacks, the drum-tag existence test and the `ilike` name
  match; `search_embeddings` and `similar_files` answer empty (the documented
  "no embeddings yet" fallback) and any test can replace a handler with
  `db.setRpc`.
- **The compute dispatcher and other egress**, through a stubbed global
  `fetch`: `/dispatch` records the job id and answers a call id, `/health` and
  `/embed_text` answer, and a test can answer any other URL (Stripe, Brave,
  a page fetch) with `world.onFetch`. Anything unanswered returns a loud 599,
  so an unexpected outbound call shows up as a failure rather than a hang.
- **Auth**: a configurable session or none; `requireUser()` throws its real 401.

## What the double cannot simulate

- **SQL.** No joins, no embedded selects (`select("*, files(*)")`), no
  expressions or `or()` filters. If a handler starts using one, the builder
  must grow with it; today it throws on `.not(col, op, …)` with anything but
  `is`, which is the only form in the codebase.
- **Triggers and foreign keys.** `updated_at` is maintained; `handle_new_user`,
  cascades, and FK violations are not. A seeded row can reference an id that
  does not exist — which is deliberate, since that is how the bundle privacy
  test builds its attack.
- **Concurrency and transactions.** No isolation levels, no races between two
  requests, no partial-failure rollback (the routes do not use transactions
  either, which is worth remembering: `/api/files/[id]/edits` writes the report
  and then the correction as two statements).
- **Realtime**, the cookie/session refresh in `middleware.ts`, tus resumable
  uploads, and range requests on signed URLs. Signed URLs are strings that
  contain the path; nothing fetches them.
- **Postgres value semantics**: numeric/text coercion, collation, timestamp
  parsing (timestamps compare as ISO strings), `check` constraints (an
  out-of-range enum value inserted through `db.seed` is accepted).
- **The real PostgREST error catalogue.** Only the codes the handlers branch
  on are produced: `PGRST116`, `23505`, `42501`, `42883`.
- **A live model turn.** `/api/chat` runs against a scripted model and
  `/api/breakdowns/[fileId]/narrate` runs with no key at all, which is the
  measured-document path.

## Coverage

All 52 route files have a colocated test; every exported method (`GET`, `POST`,
`PATCH`, `DELETE`) is exercised. Each route has, at minimum, the success path,
401 without a session, the cross-user case, and 400 for a malformed body.
Deviations, all deliberate:

| Route | Missing baseline case | Why |
|---|---|---|
| `/api/health` | 401, cross-user, 400 | Public uptime probe with no body and no user data. Tested signed-out. |
| `/api/takedown` | 401 | The public DMCA form: the whole suite runs signed-out. Honeypot, per-IP rate limit and the service-role write are tested. |
| `/api/billing/webhook` | 401 | Stripe is authenticated by the signature, which is tested with a real HMAC (good, wrong, missing and stale). |
| `/api/billing/checkout`, `/api/billing/portal` | 400 | `POST()` takes no argument; there is no body to malform. Both now assert that another user's plan and customer id are never read. |
| `/api/usage`, `/api/profile` GET, `/api/beatbox/profile`, `/api/beatbox/transcriptions`, `/api/embeddings` GET, `/api/files/[id]/bundle` | 400 | GET routes with no body; malformed path ids are tested where the handler parses one. |
| `/api/web/fetch` | cross-user | Nothing in it is per-user: the guard, robots and the cache are global. The media guard, private addresses and the 401 are tested. |

Contract-specific cases asked for, and where they are:

- Quota at upload — `files/prepare/route.test.ts` ("413s when the storage quota
  is already used up", and another user's storage does not count).
- Quota at dispatch — `jobs/route.test.ts` (a sixth stem job is refused with a
  `quota:` reason, the job row is marked `failed`, and compute is never
  called); `chat/route.test.ts` (429 after 50 turns); `web/search/route.test.ts`
  (429 after 20 searches).
- Honeypot and rate limit — `takedown/route.test.ts` (a filled honeypot is 400
  and writes nothing; the fourth notice from one IP is 429 while another IP
  still gets through).
- Signature verification — `billing/webhook/route.test.ts`.
- The media guard — `web/fetch/route.test.ts` (a media host is refused at the
  `url` stage **before any outbound request is made**, plus media extensions,
  download paths and private addresses).
- The 200 MB cap — `files/[id]/bundle/route.test.ts` (413 from the stored sizes,
  before a single object is fetched).
- The confirm card over five GPU operations — `chat/route.test.ts` (six
  `separate_stems` in one batch returns a `confirm` card with `gpu_count: 6`
  and queues nothing; re-sent with `confirmed: true` it queues six `stems`
  jobs, all owned by the caller).

No route was found untestable without a live Supabase. The two that come
closest are `/api/chat` and `/api/breakdowns/[fileId]/narrate`, which are
honest about what they cover: the wiring, persistence, quota and confirm-card
behaviour around the model, not the model's output.

## Bugs found and fixed

**1. `/api/files/[id]/bundle` served another user's audio (service role where
the user client belongs).**
`web/app/api/files/[id]/bundle/route.ts`. The route downloaded every object in
the plan with `tryAdminClient() ?? supabase`, i.e. the service role, which
bypasses the storage policies. The zip's paths come from `files.storage_path`
and `midi.storage_path`, and a user can insert rows into either table directly
with the anon key (the RLS insert policy only checks `user_id`, never the
path). A row owned by the caller but pointing at `library/{other user}/…`
therefore came back in the zip as the caller's own chop. Fix: download with the
caller's client (`supabase.storage`); the storage select policy —
`(storage.foldername(name))[2] = auth.uid()` — covers everything a kit of
theirs can legitimately contain (`library/{uid}/` and `derived/{uid}/`). Test:
"never serves bytes from another user's storage prefix".

**2. `/api/files/[id]/reanalyze` silently accepted an invalid body.**
`web/app/api/files/[id]/reanalyze/route.ts`. The body was parsed as
`parseBody(req, schema).catch(() => ({}))`, so `{"stages":["not-a-stage"]}` —
or a body that is not JSON at all — was swallowed and the route queued a full
reanalysis of every stage at 201 instead of answering 400. Fix: the
`parseOptionalBody` shape already used by `/api/breakdowns/[fileId]` (empty
body means "every stage"; anything present must validate). Tests: "400s a body
that does not validate instead of silently reanalyzing everything" and "400s a
body that is not JSON".

**3. `/api/billing/webhook` threw instead of answering when the service role was
missing.** `web/app/api/billing/webhook/route.ts`. The handler is not wrapped
in `handle()`, and `createAdminClient()` throws when
`SUPABASE_SERVICE_ROLE_KEY` is unset — so a misconfigured deployment raised an
unhandled exception out of the route (an opaque 500 with a stack) while the
same handler already answered a clean 503 for a missing `STRIPE_WEBHOOK_SECRET`
two lines earlier. Fix: `tryAdminClient()` and a 503 with the variable's name.
Test: "503s rather than throwing when the service role is not configured".

**4 and 5. `/api/files/[id]/url` and `/api/midi/[id]/download` answered 500 for
a row whose object is not in storage.** `web/app/api/files/[id]/url/route.ts`,
`web/app/api/midi/[id]/download/route.ts`. A `files` row in `uploading` status,
or audio removed underneath its row, made `createSignedUrl` fail with "Object
not found" and the route turned that into a 500 — a user-caused, user-visible
condition reported as a server fault, while the sibling list routes
(`/api/files/[id]/midi`, `/api/beatbox/transcriptions`) degrade to
`download_url: null` for exactly the same condition. Fix: a "not found" from
storage is a 404 with a sentence that says so; every other storage failure
still raises 500, so a real outage stays visible. Tests: "404s a row whose
audio is not in storage, rather than 500ing" (and the MIDI equivalent).

## Found, not fixed

- **The free-tier web-search cap does not count `/api/web/search` itself.**
  The route refuses at 429 when `webSearchesLeft(usage) <= 0`, but
  `lib/chat/limits.ts` derives that count only from `web_search` entries in the
  `tool_calls` of today's assistant messages. A direct caller of the route
  never adds to the count, so the documented cap binds the chat and nothing
  else. Note also that `lib/billing/usage.ts` counts the same quantity from
  `usage_events` rows of kind `web_search`, which nothing in `web/` writes. The
  fix belongs in `lib/chat/limits.ts` (or in a `usage_events` insert with the
  service role), both outside this seam's ownership.
- **`/api/jobs` accepts any `params` for any `kind`.** Only `file_id` is
  checked against RLS; `params.loop_id`, `params.layer_id`,
  `params.file_b_id`, `params.recording_path` and the rest are passed through
  untouched, so the web layer alone does not stop a caller from naming another
  user's row. This is defended one layer down: every compute job re-reads the
  row with the service role and refuses when it does not belong to the job's
  user (`analysis/lockedgroove/jobs/render_loop.py:162`, `layer.py:48`,
  `compare.py:25`, `beatbox_transcribe.py:44`, and `load_file_audio(…, user_id)`
  in `revoice.py` / `midi.py`). Adding a second ownership check per job kind in
  the handler would be a redesign of the route, so it is written down here
  instead. If a new job kind is ever added on the compute side without that
  check, this route is the hole.
- **The storage quota is enforced at `/api/files/prepare` only.** `complete`
  does not re-check, and tus uploads go straight to Supabase Storage with the
  user's own JWT, so a client that skips `prepare` can put bytes in the bucket
  and then register them. The cap is advisory, not enforced.
- **`GET /api/takedown` answers 405.** `docs/CONTRACTS.md` section 7 says GET is
  "the owner's review list". There is no owner-review route; the 405 body
  points at `/legal/dmca`. Either the contract line or the route should move —
  building the review list is not a test-layer change. The 405 is tested as the
  current behaviour.
- **`PATCH /api/profile` answers 404 when the profile row is missing**, while
  `GET` falls back to free-plan defaults for the same user (`getProfile` in
  `lib/billing/usage.ts`). The `handle_new_user` trigger makes this
  unreachable in practice, so it is left alone.
- **`/api/files/[id]` DELETE removes the audio before the row.** If the row
  delete then fails, the library keeps an entry whose audio is gone. The
  ordering is deliberate (the comment explains it) and there is no transaction
  across storage and the database, so this is a note, not a fix.

## What a first live signed-in session should still watch for

Everything below is real-Supabase behaviour the double asserts by construction
rather than by observation.

1. **That RLS is actually on, and the policies read the way `schema.ts` says.**
   The double grants nothing the migration does not, but it also cannot fail
   the way a missing `enable row level security` would. The first session
   should sign in as two users and confirm that user B's file id answers 404
   (not 200) on `/api/files/[id]`, `/api/loops?file_id=`, and
   `/api/breakdowns/[fileId]`.
2. **The storage policies in particular**, now that `/api/files/[id]/bundle`
   depends on them: download a kit and confirm the zip arrives, then confirm a
   signed URL for another user's object is refused. If a policy is looser than
   the migration, the bundle fix is the only thing standing between a
   hand-written row and someone else's audio.
3. **The upload round trip.** `prepare` → tus → `complete` is the one flow the
   double cannot follow end to end: tus writes the object, and `complete`
   refuses with 409 if the object is not there. Watch for a content-type or
   `x-upsert` mismatch making `complete` 409 on a good upload, and for the
   quota message at 2 GB.
4. **PostgREST error codes.** The handlers branch on `PGRST116`, `23505`,
   `42501` and `23514`; only the first three are produced here. A check-constraint
   violation (`23514` → 400) has never been seen in a test.
5. **`single()` versus `maybeSingle()` under real concurrency.** Two tabs
   completing the same upload, or two breakdown POSTs in the same second, take
   paths the double serializes.
6. **Realtime and the session cookie.** Nothing here exercises
   `middleware.ts`, the cookie refresh, or the `files`/`jobs` subscriptions.
   A signed-in session that 401s on every route points at the middleware, not
   at these handlers.
7. **The first live model turn** on `/api/chat` (tool loop, NDJSON framing in a
   browser, the confirm card round trip through the pane) and on
   `/api/breakdowns/[fileId]/narrate` (the validator's removals, and that the
   narration is saved only when the model produced it).
8. **The Stripe webhook against a real event.** The signature check is tested
   with a real HMAC, but the event payloads here are hand-written; confirm
   `checkout.session.completed` carries `client_reference_id` as expected and
   that `profiles.plan` flips.
