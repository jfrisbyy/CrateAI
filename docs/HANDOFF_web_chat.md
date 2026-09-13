# HANDOFF_web_chat.md

The chat front door with tools (Phase 8), the web information tools (Phase 5)
and hybrid search (Phase 6) of the web app. Everything listed under Files was
created or replaced by this seam; nothing outside it was edited.

## Files

```
web/lib/anthropic/
  client.ts        lazy Anthropic singleton, hasAnthropicKey(), describeAnthropicError()
  models.ts        CHAT_MODEL / QUERY_PARSER_MODEL (both claude-opus-5), token caps
web/lib/webinfo/                                   Phase 5
  types.ts         SearchProvider, FetchOutcome, Finding, WebInfo, WebInfoError
  guard.ts         checkUrl() before the request, checkContentType() after (+ test)
  cache.ts         WebCache interface, sha256 key, 24 h TTL, MemoryWebCache
  supabaseCache.ts web_cache through the service role (the only Supabase import here)
  providers.ts     Brave (GET, X-Subscription-Token) and Tavily (POST) behind one interface
  robots.ts        robots.txt parse, longest-match rules, per-host cache (+ test)
  extract.ts       readable text: headings, paragraphs, entities, 40k cap (+ test)
  search.ts        webSearch() with the cache (+ test)
  fetchPage.ts     guard -> robots -> manual redirects (max 3, re-guarded) -> content type -> extract -> cache (+ test)
  identify.ts      identityOf(), buildQueries(), identifyContext() (+ test)
  index.ts         createWebInfo() wired to env
  isolation.test.ts  grep-based: no path from a URL to files/storage/jobs; admin only for web_cache
web/lib/search/                                    Phase 6
  parse.ts         the rules parser, extended (tags, drums, loop, like this, filler) (+ test, rewritten)
  vocabulary.ts    tags.py VOCABULARY mirrored, synonyms, expandTags(), DRUM_TAGS
  claudeParser.ts  structured-output parser (zodOutputFormat), PARSER_SYSTEM, mergeParsed()
  embedText.ts     POST {COMPUTE_DISPATCH_URL}/embed_text; EmbedUnavailableError
  merge.ts         matchedFor(), passesFilters(), mergeHits() (vector by similarity, then filters)
  hybrid.ts        hybridParse(), hybridSearch() with injected deps (+ hybrid.test.ts)
  memo.ts          30 s TTL memo (one parse + one embed per query even when asked twice)
  server.ts        deps from the session client + env + Anthropic; runLibrarySearch()
web/lib/chat/                                      Phase 8
  protocol.ts      NDJSON events, encodeEvent(), EventDecoder (+ test)
  cards.ts         Card union, ToolOutcome, ToolCallRecord
  tools.ts         the 19 strict tool definitions, GPU_TOOLS, BATCH_GPU_CONFIRM (+ test)
  report.ts        compactReport(), explainReport(), vitalsOf(), step names (+ test)
  system.ts        SYSTEM_PROMPT (principles, GROUNDING_CONTRACT, vocabulary, LINK_REFUSAL), buildContextBlock() (+ test)
  db.ts            ChatDb interface + supabaseChatDb() (session client, RLS)
  handlers.ts      runTool(): zod validation, every handler, batch confirmation
  loop.ts          runToolLoop(): the streaming manual tool loop (+ test)
  history.ts       textOfContent(), toolCallsOf(), citationsOf(), historyFromRows()
  limits.ts        FREE_TIER constants, readUsage(), quota messages (+ test)
  fakes.ts         MemoryChatDb, fakeWeb, fakeSearch, scriptedModel (tests only)
  grounding.test.ts  the section-14 fixtures against the handlers
web/lib/api/chat.ts      streamChat(): POST /api/chat + event decoding
web/lib/api/search.ts    searchLibrary(), embeddingsStatus(), queueEmbeddings()
web/app/api/chat/route.ts        the streaming route (replaced)
web/app/api/search/route.ts      hybrid search (replaced)
web/app/api/embeddings/route.ts  GET status / POST queue embed jobs (new)
web/app/api/web/search/route.ts  web_search as a route (new)
web/app/api/web/fetch/route.ts   fetch_page as a route (new)
web/components/chat/ChatPane.tsx        replaced: attachments, live turn, cards, surface actions
web/components/chat/MessageList.tsx     replaced: tool rows, cards, citations, live turn
web/components/chat/ToolCard.tsx        the cards (+ ToolCard.test.tsx)
web/components/chat/AttachmentChips.tsx the files-in-context row
web/components/chat/Composer.tsx        kept; placeholder updated
web/components/library/SearchBox.tsx    replaced: chips and matched fields under the box
```

Total: 7,403 lines including tests. `web/lib/anthropic/narrate.ts` (another agent's) was not touched.

## Commands and results

| Command (from `web/`) | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0, no warnings |
| `pnpm test` | 44 files, 376 tests passed (this seam adds 20 files / 190 tests: webinfo 76, search 27, chat 80, cards 7; the rest are the other seams') |
| `pnpm build` | exit 0; `/api/chat`, `/api/search`, `/api/embeddings`, `/api/web/search`, `/api/web/fetch` compiled as dynamic routes; `/f/[fileId]` 277 kB first load |

No test touches the network: the Anthropic client, the search provider, page
fetches, compute and Supabase are all injected doubles (`lib/chat/fakes.ts`,
recording `fetch` functions, `MemoryWebCache`, `MemoryChatDb`). Not exercised
here, because there is no key, provider or Supabase session in the sandbox:
a real model turn, a real Brave query, and the routes end to end. The first
signed-in run should watch: the `cache_control` breakpoint on the system
prompt (`usage.cache_read_input_tokens` should be non-zero from the second
turn), the strict tool schemas being accepted by the API (every object has
`additionalProperties: false`; optional properties are omitted from
`required`, which is what the SDK's own zod helper emits), and the NDJSON
stream arriving incrementally through Vercel (the route sets
`cache-control: no-store` and `maxDuration = 300`).

## Interpretation choices

**Chat**

- **Protocol.** `POST /api/chat` streams `application/x-ndjson`, one event per
  line: `text`, `tool_call`, `tool_result` (with the card), `citations`,
  `done { message_id, conversation_id }`, `error`. The Phase 0 `text/plain`
  stream is gone; `x-conversation-id` and `x-user-message-id` headers stay.
  Errors before the stream starts are JSON `{ error }` with a status (401,
  400, 404, 429 quota, 503 no key); errors inside the stream are an `error`
  event followed by `done`, so the pane always closes the turn.
- **Body.** `{ conversation_id?, message, file_ids?, open_file_id?, batch? }`.
  `content` (the Phase 0 client's name) is accepted as an alias of `message`
  so `lib/api/types.ts` (not this seam's file) stays true.
- **The loop** (`lib/chat/loop.ts`) is the manual streaming loop from the
  brief: `messages.stream` with adaptive thinking and `effort: "medium"`,
  text deltas emitted as they arrive, `end_turn` stops, `pause_turn` pushes
  the assistant turn and continues, `tool_use` runs every tool and pushes
  ONE user message with all `tool_result` blocks (tested), 12 iterations
  max, `refusal` / `max_tokens` / context-window stops say so in the text.
  Between iterations a `"\n\n"` delta separates "Let me look." from the
  answer, and the persisted text is the iterations' text blocks joined the
  same way. Tool results are clipped at 30k characters before the model.
- **Persistence.** The user message first; then one assistant message whose
  `content` is `[{ type: "text", text }]`, `tool_calls` is
  `ToolCallRecord[]` (`id, name, input, summary, card, is_error, searches?,
  nested?`) and `citations` is every web citation used. History for the next
  turn is text only: assistant rows carry a `[Tools used: name: summary; …]`
  note instead of replayed `tool_use` blocks (`lib/chat/history.ts`), which
  keeps the transcript valid and short. The last 40 rows are sent.
- **System prompt** is two blocks: the frozen `SYSTEM_PROMPT` with
  `cache_control: ephemeral` (principles in the model's voice, the grounding
  contract verbatim, hedge bands, producer vocabulary, the one-sentence link
  refusal, tool guidance, style), then the per-turn context block (date,
  attached files with ids and hedged vitals, the open file's compact
  effective report for structure/drums/sample use/loudness/tags/edits).
  Nothing volatile is in the cached block (tested).
- **get_report is compact by design.** The full report is large (beat and
  onset times), so `compactReport` returns vitals with confidence and hedge,
  sections, a per-section drum pattern in step names ("the one and the and
  of three"), sample use, chords (capped at 96 segments), instrumentation,
  loudness, spectral, effects estimates, tags, user edits, and
  `not_analyzed: [...]`; `sections` narrows it. `explain` is one line per
  fact with `hedged()` from `lib/report/hedge.ts` on every value.
- **set_edit** reuses `lib/report/edits.ts` (`editRequestSchema`,
  `applyEdit`, `predictedFor`) and logs the corrections row exactly as
  `/api/files/[id]/edits` does. Its `value` is an object with one of
  `number | text | key | section_labels[]` so the schema stays strict.
- **batch** carries each operation's input as `input_json` (a JSON string):
  a free-form nested object is not expressible in a strict schema. More than
  5 GPU operations (`separate_stems`, `revoice`, `embed`) return a `confirm`
  card instead of running (E.23); the card's Run re-sends the same
  operations with `batch: { operations, confirmed: true }`, the route appends
  a note to the user text asking the model to call `batch` with
  `confirmed=true`, and the handler also accepts the batch when its
  fingerprint matches the confirmed one, so the confirmation holds even if
  the model forgets the flag. A batch cannot contain a batch; 20 operations
  max.
- **embed** is an extra tool (queues the `embed` job, GPU) so the model can
  offer it when text search says it needs embeddings, and so batch can count
  it as the brief lists.
- **Jobs are inserted the way the routes insert them** (same params:
  `find_loops` as `analyze { task, bars, top_k }`, `render_loop { loop_id,
  crossfade_ms: 12, snap_zero_crossing: true }`, `stems { model }`, `chop {
  mode, ... }`, `midi { kind }`, `revoice { instrument, path }`, `breakdown
  {}`, `compare { file_a_id, file_b_id, a_name, b_name }`, `layer { layer_id
  }`) and dispatched with `lib/compute/dispatch.ts`. A failed dispatch is
  reported honestly in the tool text and on the card ("compute not
  configured"); the job stays queued for Retry.
- **layer** writes `layers` + `layer_items` (position, gain, offset) then the
  `layer` job with `file_id = null` (a layer is not a file). `find_loops`
  returns existing finder loops unless `refresh`; `breakdown` returns the
  latest document when it is newer than the last edit; `compare` returns the
  latest comparison; `separate_stems` lists existing stems for that model
  instead of re-queueing. Active queued/running jobs are returned instead of
  duplicated.
- **Cards** are plain JSON in `tool_calls` and render again from the rows.
  Job cards read status and progress live from `LibraryProvider.jobs`; a
  loops card's "Show on surface" navigates to the file if needed and then
  dispatches `crateai:select-loop` with the loop id as `detail`; breakdown
  and compare cards navigate and dispatch `crateai:tab`; search cards Open
  the file; web cards are links; edit cards show field, predicted,
  corrected; confirm cards have the Run button (the only amber besides the
  running line). Cards are pure components (`actions` injected), tested with
  `react-dom/server`.
- **Attachments.** The open file (`/f/[fileId]`) is attached when it opens;
  detaching it sticks until another file opens. A chip row attaches any
  ready library file; the conversation's `file_ids` is the union of what was
  ever attached, the turn's context is what is attached now.
- **Quotas** (`lib/chat/limits.ts`): `FREE_TIER` constants (50 turns/day,
  20 searches/day, 2 GB, 5 stem jobs/month). Turns are the caller's user
  messages since midnight UTC; web searches are counted from the tool calls
  recorded on the day's assistant messages (`web_search` = 1,
  `identify_context` = its `searches`), so no schema change was needed. The
  route returns 429 with a clear sentence at the turn cap; the tools return
  an error result at the search cap. `identify_context` may overrun the cap
  by up to four searches on the boundary (it runs its five in one call).
  The direct `/api/web/search` route checks the count but does not add to
  it (documented gap; see the usage-events proposal).
- **Models.** Both constants are `claude-opus-5`; the parser's is the one to
  switch to `claude-sonnet-5` for cost. `maxDuration = 300` on the chat
  route (a Vercel Hobby plan caps at 60 s; long tool turns need Pro).

**Web information**

- **Guard before the request:** media platforms and their CDNs (youtube,
  youtu.be, googlevideo, soundcloud, sndcdn, spotify, scdn, music.apple,
  mzstatic, tidal, deezer, dzcdn, mixcloud, audiomack, vimeo, dailymotion,
  tiktok, twitch, bcbits), bandcamp download/stream paths, file-sharing
  download hosts, `/download/`, `/stream/`, `/dl/` paths, media extensions
  in the path or a query value, non-http schemes, credentials in the URL,
  private and local addresses (SSRF). **After the response:** only
  `text/html`, `text/plain`, `application/xhtml+xml`, `application/json`;
  the refusal names the type. Redirects are followed manually (max 3) and
  every hop is re-guarded, so a redirect to a media URL is refused. 10 s
  timeout, 2 MB body cap, 40k characters of extracted text. The chat's
  `fetch_page` prefixes the standard sentence to any media refusal.
- **robots.txt** is fetched once per host per day (in-process cache),
  longest-match rules with allow winning ties, our group (`CrateAI`) before
  `*`; unreadable robots means open. A disallowed path answers "the site
  disallows fetching …".
- **Cache:** `web_cache` keyed by `sha256(provider|kind|normalized query)`,
  24 h, through the service role (the table has no policies). Without
  `SUPABASE_SERVICE_ROLE_KEY` it degrades to memory. `web_cache` is not in
  the hand-written `Database` type, so `supabaseCache.ts` uses the untyped
  client for that one table.
- **identify_context** reads `files.title` / `files.artist`, else a filename
  shaped "Artist - Title" (track numbers and "(Official Audio)" stripped);
  five queries in the order the brief lists, capped at 5 searches, one
  finding per result (first sentence of the snippet, verbatim), results
  without a URL dropped, deduped by kind+URL. It never sees the audio.
- **Provider:** Brave by default, Tavily by `WEB_SEARCH_PROVIDER=tavily`,
  8 results per query.

**Search**

- **Parser.** Rules first (`lib/search/parse.ts`): bpm forms, key spellings,
  `kind:` and the spoken words (stems, chops, re-voices), `no drums` /
  `drumless` / `with drums`, `loop` / `loop-based`, `like this` / `similar`,
  vocabulary tags (multi-word first) and a few synonyms (horns, keys, vox,
  synth, break…), and filler words dropped from `text_query` so "Something
  dusty in F minor around 85 with horns, no drums" gives text "dusty
  horns" and tags dusty/horns. Tag words stay in the text: that phrase is
  what the CLAP embedding wants. Claude (structured output, `QuerySchema`)
  runs only when free text remains and a key is present; the rules' values
  win, Claude fills nulls and adds tags; `parsed_output === null` or a
  thrown call falls back to the rules (tested with a fake client).
- **Tags are soft.** Hard filters (bpm, key, kind, drums, loop-based) go to
  the RPCs; tags are used for the `matched` display and, in filters mode,
  for a second `library_filter(p_tags)` call whose hits are unioned in.
  `expandTags()` maps typed words onto database tags (horns → brass,
  trumpet, saxophone).
- **Vector mode** needs at least one embedding row (a cheap count under
  RLS), compute reachable, and a non-503 answer; otherwise mode is
  `filters`, `note` says `text search needs the embed job / compute (why)`,
  and the text becomes a name match (`p_text`), falling back to the
  structured filters alone when the words match no name. "like this"
  resolves against `current_file_id` (the open file, sent by the SearchBox
  and by the chat as the open file); `similar_files` takes no filters, so
  the parsed ones are applied to its hits here; the source file is never
  its own neighbour.
- **Response:** `{ results: [{ file, matched, similarity? }], parsed, mode,
  note, files }`. `files` is `results[].file` because the shell's search
  state reads `res.files` and `res.parsed` (not this seam's file). The
  route memoizes per user/query for 30 s so the SearchBox's second request
  (for the matched fields) costs nothing.
- **SearchBox** runs the shell's `search.run` (the library pane keeps
  working as before) and `searchLibrary` for the details: chips under the
  box (bpm range, key, kind, drums, loop, like this, `#tags`, "text"), the
  mode, the note with an "Embed library" button (POST `/api/embeddings`),
  and up to 8 results with the matched fields and Open. Escape closes the
  panel, then clears.
- **`/api/embeddings`**: GET reports embedded/ready counts and the missing
  ids; POST queues `embed` jobs for the missing files (or given ids),
  skipping files with an embed job in flight, capped at 200, dispatching
  each. `POST /api/files/[id]/embed` was left alone as instructed.

## Needs in shared files (not edited; one-line changes for their owners)

- `web/lib/types/db.ts`: `LibraryFilterArgs` should gain `p_has_drums`,
  `p_is_loop_based`, `p_tags`, `p_text` (the RPC has them; `server.ts`
  casts for now); a `web_cache` table type would let `supabaseCache.ts`
  drop the untyped client.
- `web/lib/api/types.ts`: `SearchResponse` should add `results`, `mode`,
  `note`; `ChatRequest` should rename `content` to `message` (both are
  accepted by the route). `lib/api/search.ts` and `lib/api/chat.ts` carry
  the exact shapes meanwhile.
- `web/components/shell/searchState.tsx`: reading `res.results` (with
  `matched`) into the state would let the library rows show the matched
  fields without the SearchBox's second request; until then the SearchBox
  panel shows them.
- `web/components/surface/Surface.tsx` / `surfaceState.tsx`: listen for
  `crateai:select-loop` (`detail` = loop id) and call `selectLoop(id)`,
  refetching loops first if the id is unknown; the chat dispatches it after
  navigating to the file. `crateai:tab` already works.
- `web/lib/env.ts`: `serverEnv` could list `WEB_SEARCH_PROVIDER`,
  `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`; `lib/webinfo/index.ts` reads
  `process.env` directly for those three.
- `docs/CONTRACTS.md` section 7: `/api/chat` streams NDJSON (events above),
  not text; new routes `GET/POST /api/embeddings`; `/api/search` takes
  `current_file_id`.

## Proposals (PROPOSALS.md template)

## Usage events for quotas
**What it does for a producer:** The free tier's counts stay right no matter which surface spent them (chat, the search box, the breakdown's context section), and the usage page can show them.
**Principle it serves:** 5 and the Phase 10 acceptance line.
**Principle it risks:** None; the table is per user under RLS.
**What it takes:** A `usage_events(user_id, kind, count, created_at)` table written by the chat tools, `/api/web/search` and the embed/stems queues; `lib/chat/limits.ts` reads it instead of `messages.tool_calls`; Stripe metering reads the same rows.
**Where it belongs:** Phase 10.
**Status:** proposed.

## Loop selection from the chat
**What it does for a producer:** "Show on surface" on a loop card selects and plays that loop on the waveform, even when the finder wrote it a second ago.
**Principle it serves:** 4, every output is editable; 14's "every result is an object on the surface".
**Principle it risks:** None.
**What it takes:** A `crateai:select-loop` listener in `Surface.tsx` that refetches loops when the id is unknown, then `selectLoop` and `playLoop`; the event is already dispatched.
**Where it belongs:** Phase 8 wiring (surface seam).
**Status:** proposed.

## Matched fields on the library rows
**What it does for a producer:** Search results in the library pane show why each file matched (92 BPM, F minor, dusty, 0.87), not only the name.
**Principle it serves:** 2 and 5.
**Principle it risks:** None.
**What it takes:** `searchState.tsx` keeps `results` (with `matched`) and `FileRow` accepts an optional `matched` line; the route already returns them and the SearchBox panel shows them today.
**Where it belongs:** Phase 6 polish.
**Status:** proposed.

## Compact the chat transcript server-side
**What it does for a producer:** Long conversations about a whole crate keep working instead of stopping with "start a new one".
**Principle it serves:** 5.
**Principle it risks:** 2, if a summary drops a hedge; mitigated because facts are re-read from the report by tools, never from the summary.
**What it takes:** The API's compaction (`compact-2026-01-12` beta) on the chat call, storing the compaction block with the assistant message and replaying it; or a local summary of rows older than the last 40.
**Where it belongs:** Phase 8 hardening.
**Status:** proposed.

## Environment variables the owner must set

| Name | For | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | chat turns, the hybrid parser | without it `/api/chat` answers 503 and search runs the rules parser alone |
| `WEB_SEARCH_PROVIDER` | `brave` (default) or `tavily` | |
| `BRAVE_SEARCH_API_KEY` | web_search, identify_context | required when the provider is brave |
| `TAVILY_API_KEY` | same, when the provider is tavily | |
| `SUPABASE_SERVICE_ROLE_KEY` | the `web_cache` table (no policies) | without it the web cache is in-memory per instance |
| `COMPUTE_DISPATCH_URL`, `COMPUTE_DISPATCH_SECRET` | `/embed_text` for text search, job dispatch for every queued tool | without them search says "text search needs the embed job / compute" and jobs stay queued |

Text search also needs the `embed` job to have run on the library (GPU
image with `laion-clap`, or `LOCKEDGROOVE_FAKE_EMBEDDER=1` on the local
runner for development): the SearchBox's "Embed library" button and the
chat's `embed` tool queue it.
