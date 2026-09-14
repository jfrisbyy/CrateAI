# HANDOFF_chat_surfaces.md

The chat reaching the surfaces built since Phase 8 — the session transport, the
song timeline, the candidate rack, per-track processing, export and the
keyboard instrument.

The packet calls the chat the front door. Its tool list was Phase 8 vintage:
files, loops, stems, chops, MIDI, breakdown, compare, search, web. Everything
built since could be done with a mouse and none of it by asking, which breaks
the rule stated in `docs/PRODUCT_DIRECTION.md` and repeated in every handoff
after it:

> Everything the panels do by mouse can be said in a sentence, and whatever the
> sentence does shows up on the control the mouse would have used.

## What a producer can say now that they could not before

Every one of these reaches the same control the mouse moves, and the reply is
the line that control itself produces:

```
solo the drums, then loop bars 9 to 16 and play it
move the horns to bar 17 and trim them to 4 bars
this trumpet sounds awful — clean it up
cut 250 on the drums by 4 dB and high-pass the bass at 80
a/b the horns
tune the trumpet up 20 cents
rack me some drums, play the third one under this, keep it
what's in bar 17?
where did the drums on this lane come from?
export the song as stems
switch the pads to gate and give me the 32-key layout
undo that
```

## The architectural knot, and the shape chosen

The chat runs on the server. The session runs in the browser: the transport,
the arrangement, the processing graph, the rack and the undo stack are all
client state no route can see or change.

`lib/session/commands.ts` already turns a sentence into a `SessionCommand`, and
`components/shell/sessionCommands.ts` is a bus the shell and the processing
provider listen on, applying each command to the real control and returning one
line in that control's own words. That machinery is built and well tested. The
job was to connect the model to it without building a second, divergent path.

**The shape: the model does not get session mutations — it gets to say the
sentence.**

`session_control` takes `steps`, each one a sentence in the session's own
command vocabulary. The handler runs each step through the *same*
`parseSessionCommand` (then `parseKeyboardCommand`) the composer's own command
line runs, checks it against a snapshot of the open session using the *same*
exported resolvers the shell uses, and returns a **directive card** carrying
the parsed command. The client puts it on the existing bus.

```
producer types          "solo the drums"
                             |
                    parseSessionCommand
                             |
model says a step      { kind: "solo", target: "drums", on: true }
"solo the drums"             |
       |               emitSessionCommand  ──► applySessionCommand / ProcessingProvider
parseSessionCommand          |                          |
   (on the server)           |                   the control moves
       |                     |                          |
  directive card ────────────┘               emitCommandResult("soloed drums")
                                                        |
                                            the echo under the composer,
                                            and the words the model answers in
```

Three consequences, and they are the point:

- **One parser, one dispatcher.** There is no expression the model can make
  that does not end up in the same `SessionCommand`/`KeyboardCommand` union and
  the same providers. Nothing in `lib/chat/**` mutates a session.
- **The producer sees what happened.** A sentence that moves a fader moves the
  fader, because it *is* the fader's own command. The reply says it in the
  control's words because `describeCommand` — the function the echo uses — is
  what fills the tool result.
- **The vocabulary cannot drift.** Adding a verb to the parser adds it to the
  chat, with no second list to update. (The one thing that must be kept in step
  by hand is the grammar block in `lib/chat/surfaces.ts`; see "Known seams".)

### Why a directive rather than a server-side effect

Because there is nothing on the server to affect. A `tool_result` already
streams a card the client acts on (`confirm` has a Run button), so a directive
is the existing protocol used honestly rather than a new mechanism.

### Why export is a tool and not a directive

Export is a job: it needs ownership resolution under RLS, a `jobs` row, quota
and dispatch. So `export_song` is a normal tool that queues work. The song it
renders comes from the snapshot in the `ToolContext` — the real arrangement,
never the summary — and the handler mirrors `POST /api/export/song`: the same
`buildExportRequest`, the same `estimateExport` refusals before any compute is
spent, the same ownership check through the caller's RLS client.

## Files

```
web/lib/chat/
  surfaces.ts        the whole seam: the snapshot and its zod schema, the
                     session block and the grammar, planning steps into
                     directives, the refusal checks, reading the song  (+ test, 31)
  surfaces.test.ts   one parser, failures as answers, grounding
  surfaceTools.test.ts  the three tools against the fakes             (test only, 16)
  tools.ts           (edited) three tools added; sixteen descriptions trimmed
                     to pay for them — see "The cost"
  handlers.ts        (edited) ToolContext gained `session`/`sessionFiles`;
                     three handlers; a batch may not carry a directive
  cards.ts           (edited) `directive` and `session` cards
  system.ts          (edited) one paragraph; buildContextBlock takes the
                     snapshot and the session's library rows
  fakes.ts           (edited) fakeSnapshot / fakeTrack / fakeRegion
  system.test.ts     (edited, additive) the session block, and its absence
web/components/chat/
  directive.ts       putting a directive on the bus, once, in order   (+ test, 7)
  sessionSnapshot.ts packing the session for a turn                   (+ test, 11)
  ChatPane.tsx       (edited) sends the snapshot; runs directives live
  ToolCard.tsx       (edited) the two new cards, as receipts
  ToolCard.test.tsx  (edited, additive)
web/lib/api/chat.ts  (edited) `session` on ChatSendBody
web/app/api/chat/route.ts  (edited) validates the snapshot, reads the session's
                     library rows, puts the block after the cache breakpoint
```

`lib/session/commands.ts` was **not** changed. Nothing in `lib/session/*`,
`lib/processing/**`, `lib/export/**`, `lib/pads/**`, `components/{shell,
timeline,rack,processing,keyboard,onboarding}/**`, `analysis/**`, `supabase/**`
or any other API route was touched.

## The tool list, and the cost

The budget is a hard gate: `lib/billing/promptBudget.test.ts` fails if the
cached prefix outgrows `CHAT_TURN_SHAPE.cached_prefix_tokens` (7,000), which is
what the tiers were priced from, and `lib/billing/cost.ts` is another seam's
file. **Before this work the prefix was 6,636 tokens — 364 to spend.** Three
tools and a paragraph of prompt cost 830. So sixteen existing tool descriptions
were tightened (no contract clause removed: every "never…", every refusal list
and every grounding sentence is intact, and `tools.test.ts` still asserts each
description names what the tool will not do).

| | tokens |
|---|---:|
| tools, before | 5,282 |
| tools, after | 5,378 |
| system prompt, before | 1,354 |
| system prompt, after | 1,489 |
| **prefix, before** | **6,636** |
| **prefix, after** | **6,867** |
| budget | 7,000 |
| **headroom left** | **133** |

The three new tools, and the trimming that paid for them:

| tool | tokens | what it is |
|---|---:|---|
| `session_control` | 296 | `steps: string[]` (1–8). The only write into the browser. |
| `read_session` | 183 | `bar?`, `track?`. The detail half of OPEN_QUESTIONS 39. |
| `export_song` | 216 | `format?`, `include_muted?`. Queues the job. |
| | **695** | |
| freed by trimming sixteen descriptions | **−599** | `uuid()`'s suffix alone was 37 chars × 16 uses |

**133 tokens is thin, and the next agent should know it.** It is about one
small tool. If another is genuinely needed, the honest move is to re-price
`CHAT_TURN_SHAPE` deliberately rather than to shave descriptions further — the
descriptions are now at the point where the next cut costs meaning.

### Consolidation, not one tool per verb

Twenty verbs behind one well-described tool, because the *vocabulary* is the
expensive part of a tool schema and this one does not carry its vocabulary in
the schema at all (below). One tool per verb — transport, mute, solo, gain,
move, trim, split, duplicate, delete, snap, zoom, undo, eq, tune, bypass,
limiter, rack, audition, commit, kit, layout, take — would have been several
thousand tokens and would have needed its own dispatcher, which is the
divergence the brief warned against.

## What the model is told about the open session

A compact block in the **volatile** half of the turn — after the cache
breakpoint, alongside the attached files — and only when a session is open.
It is `sessionLines()` in `lib/chat/surfaces.ts`:

```
The producer has a session open. These are the positions of controls on their
screen, not measurements of audio.
grid: 92 BPM, 4/4, bar 1 is second 0 | snap bar | playing at bar 5.2 | loop bar 1 to bar 5 | master +0 dB, limiter off
lanes (2), in the producer's order:
  Drums | Masquerade, drums, bars 9-16 | -2 dB | 2 regions | chain: 250 Hz -4.0 dB | record: 92 BPM (0.91), F minor (0.7), bandwidth 13.5 kHz (rolloff_0.99)
  Horns | Moonlight Highlife, other | +0 dB | 1 region | muted
  song length 41.6s (11.02 bars)
selected region: on Drums, bar 5, for 10.44s — this is what "it" means in a step.
the processing dock is on Horns, which is the lane a chain step with no lane named means.
rack "on the panel" — the rows are on the panel and not listed here:
  3. In The Shade — the break — vocal-free, 0.86 (0.86), auditioning under the session now
undo: trim the start
session_control steps, in the session's own words — one control per step, said exactly like these:
  transport: play | pause | stop | loop bars 9 to 16 | loop 12s to 20s | loop off
  mix: mute the drums | unmute everything | solo the horns | ...
  song: show the song | move the drums to bar 17 | trim the drums to 4 bars | ...
  rack: rack drums | hear what fits this | play the third one | next | keep it | ...
  chain: show the eq on the horns | make the horns less muddy | cut 250 on the horns by 4db | ...
  panel: close the panel | go back
```

Four decisions in it worth defending:

**The grammar rides in the volatile block, not in the tool description.** That
is backwards from a caching standpoint and it is the budget's fault: with 364
tokens of prefix left there was no room for a 300-token grammar, and the budget
test is a hard gate. The consolation is real, though — the block costs *nothing*
until a session exists, and it lists **only the families that have something
listening right now**: no `song`/`chain`/`mix` lines until a lane exists, no
`rack` line without a file or a rack, no `keyboard` line off a file surface.
If the prefix is ever re-priced, moving the grammar into `session_control`'s
description is a copy-paste and a strictly better trade.

**Measured values come off the report row on the server, never off the wire.**
The browser sends controls — names, gains, locators, what is selected, what
each chain reads. The route then reads the library rows the lanes point at
(`sessionFileIds` → `db.getFiles`, under RLS) and the block states each
record's tempo, key and **bandwidth with the method that measured it**. There
is a test asserting the snapshot carries no bandwidth, no key and exactly one
`bpm` (the session's own grid, which is a control, not a measurement). So a
musical fact in an answer always traces to the analysis, exactly as with
`get_report`.

**The arrangement travels in full, but only to the tools.** `ToolContext.session`
holds the real `SessionTrack[]`/`SessionRegion[]` with lineage, because the
export renders it and a summary would be a second, lossy model of the song.
Only `sessionLines()` is ever put in front of the model. When the song tables
land (`20260913001000_song_arrangement.sql`, written and unapplied) this field
becomes a session id and the server reads the same shape out of them; nothing
else changes.

**What the tail actually costs**, measured:

| | tokens |
|---|---:|
| no session | 379 |
| an empty session | 537 |
| one lane | 758 |
| six lanes, eighteen regions, chains, a rack, the keyboard | 1,099 |

`CHAT_TURN_SHAPE.fresh_input_tokens` is 3,000 and the budget test caps the
no-session block at half of it. A six-lane session is a third of the tail;
a session past about twenty lanes would be worth summarising harder
(the obvious first cut is one line per lane instead of two).

## How a failure reads

Failures are answers, and the answer is the line the control itself would have
put in the chat — because it is the same line, from the same resolver.

| the step | what comes back |
|---|---|
| `mute the horns`, no such lane | `nothing in the session is called horns.` |
| `loop bars 9 to 16`, no measured tempo | `the session has no measured tempo yet, so it has no bars. Say it in seconds, or commit something with a tempo.` |
| `move it to bar 17`, nothing selected | `nothing is selected on the timeline, so there is no region to change. Click one, or name the lane.` |
| `duplicate the drums`, two regions on it | `Drums has 2 regions. Click the one you mean, then say it again.` |
| `keep it`, nothing auditioning | `nothing is auditioning, so there is nothing to keep.` |
| `hear what fits this`, no file open | `no file is open, so there is nothing to rack against.` |
| `bypass the eq`, no lane under the hand | `nothing in the session is called the lane you are on.` |
| `gate`, the instrument not on screen | `the keyboard instrument is not on screen, so nothing would hear that. Open a file's chops surface first.` |
| `sidechain the pad to the kick` | `that is not one of the session's steps.` + the vocabulary |
| every step refused | an **error** outcome carrying each refusal and the whole grammar |
| a step emitted that nothing answers | `nothing on screen answered that — the control it names is not open.` |

The last one is the anti-silence rule made mechanical. The keyboard's bus only
has a listener while its panel is mounted, so `directive.ts` waits 700 ms for a
control to speak and, if none does, says so in the echo rather than leaving a
blank. Steps run one at a time and one unheard step does not stop the rest.

A mixed result is **not** an error: the steps that could be carried out are, the
ones that could not are named, and the tool result lists both so the reply can
say "I soloed the drums; there is no lane called horns."

## Grounding

Unchanged, and structurally so:

- `GROUNDING_CONTRACT` was not edited. Musical facts still come only from
  `get_report`/`explain` (and now from the session block, which is built from
  the same report rows with the same methods attached).
- A directive's schema has nowhere to put a fact: a step is a control move, and
  the result carries only the line the control says. The tool's note tells the
  model in as many words: *"Say the lines back as they read; do not add a
  number a line does not have."*
- The one place the chat could have started asserting audio facts — the
  per-track EQ — cannot, because the chat does not choose frequencies. A
  complaint (`make the horns less muddy`) goes to `lib/processing/complaints.ts`
  through `ProcessingProvider`, which applies the bandwidth guard: a lift above
  the record's **measured** ceiling is pulled down and the refusal is reported.
  A spoken move (`boost the air on the horns`) goes down the same path.
- The export attributes the song's key to the record it was measured on, and
  writes no key at all when nothing measured one — asserted.

## What was deliberately not exposed

**`PROPOSE_PROCESSING_TOOL`.** `docs/HANDOFF_processing.md` section 10 calls
its absence "the single biggest gap", and it is written, validated and tested
in `lib/processing/propose.ts`. It is **938 tokens** of tool schema against 364
of headroom: seven times what was available. It is also, mostly, already
reachable — every `fix` and `eq` verb in the parser produces a real
`ProcessingProposal` through `proposeForComplaint`/`proposeForPhrase`, applied
by `applyProposal` with the clamps reported, the bandwidth guard on, the curve
marked, the confidence dot hedged and one press to put it back. What is lost is
the model writing its *own* multi-move proposal with a per-band `why` and a
summary in its own words — real, but a poor trade at that price. If the prefix
is re-priced, this is the first thing to add, and wiring it is one entry in
`CHAT_TOOLS` plus one handler that builds the brief from the snapshot (every
field of `ProcessingBrief` is already in it except the complaint).

**New verbs in `lib/session/commands.ts`.** Two genuine gaps exist — **seek**
("go to bar 17"; the mouse scrubs the ruler) and **master level** ("turn the
master down"; `resolveTarget` finds no lane called master). Neither was added,
because a new member of the `SessionCommand` union makes the exhaustive switch
in `components/shell/applyCommand.ts` non-exhaustive and that file belongs to
another seam. Each is one union member, one `describeCommand` case and one
`applyCommand` case. Also missing a sentence, for the same reason: region gain,
renaming a lane, moving a region to another lane, and reordering lanes.

**Export verbs in the parser.** "Export the song" is deliberately *not* a
client command: `SongExport.tsx` is built but not mounted
(`docs/HANDOFF_export.md` section 11), so a parsed export command would be
swallowed and do nothing. It reaches the model, which calls `export_song`. When
the panel is mounted, the parser verb can be added and the tool kept — they
queue the same job.

**The rack's rows.** `components/rack/**` is another seam, and `ChatPane`
cannot read the panel's list without opening a second `useRack`. So the
snapshot carries only the candidate that is *sounding* (from `session.auditioning`)
with `listed: false`, and the server then refuses to decide anything about a
row it cannot see: "play the third one" and "next" are carried to the rack,
which answers for itself. When a rack row list is reachable, set `listed: true`
and the existing checks start deciding.

**MIDI in the chat's export.** `ChatDb` has no `midi` accessor, so
`export_song` sends `midi_ids: []`. A producer who wants their pad takes in the
zip uses the panel. One method on `ChatDb` closes it.

**`session_control` inside a `batch`.** Refused, with a message. A batch's
nested cards never reach the client's directive path, so it would be stored and
silently never applied — the one failure worse than a refusal.

**The `corrections` write** when the model picks row three. Still needs a
route, as `docs/HANDOFF_session_transport.md` section 9 says.

## What only a live model turn can confirm

There is no key and no network here; the model half is exercised against the
scripted double in `lib/chat/fakes.ts`. In the order a first real session
should walk them:

1. **Whether the model says the steps the parser accepts.** This is the whole
   bet. The grammar block gives exact forms and a miss returns the vocabulary,
   so the failure mode is a wasted round rather than a wrong edit — but if the
   model paraphrases ("turn down the drums a bit" instead of "turn the drums
   down 3db") often enough, the answer is to widen the parser, not to widen
   the tool. Watch the refusal rate on the first ten sessions.
2. **Whether it uses the control's words.** The result carries each line
   verbatim and the prompt tells it to. Check it does not re-word "soloed
   drums" into "I've isolated the drum track", and does not invent a frequency
   after a `fix` step.
3. **`required: []`.** `read_session` and `export_song` declare no required
   fields under `strict: true`. Every existing tool has at least one. Confirm
   the API accepts an empty `required` array; if it does not, make `bar`
   required on `read_session` and `format` required on `export_song`.
4. **Whether one call carries several steps.** `steps` is capped at 8 to keep a
   five-clause sentence to one round instead of five. Confirm the model batches
   rather than calling the tool once per verb (that is the cost difference
   between one model call and five).
5. **The 700 ms timeout.** It is a guess. If a slow first render makes a real
   answer arrive late, the producer sees "nothing on screen answered that"
   followed by the control moving — worse than waiting. Watch for it and raise
   the constant if it happens.
6. **Two command lines at once.** The result buses are shared: if a producer
   types a command *while* a directive is running, the runner may take their
   line as its own. Rare, and the fix is a correlation id on the bus, which is
   another seam's file.
7. **Wire size.** The whole arrangement travels on every turn. A six-lane song
   is a few tens of kilobytes; a 600-region song with lineage could be several
   hundred. Measure it on a real song. The real fix is persistence — then the
   snapshot is a session id.
8. **The tail on a big session.** 1,099 tokens at six lanes, uncached, every
   turn. Watch the input-token line on a working session against the
   projections in `lib/billing/cost.ts`.
9. **Whether the keyboard heuristic holds.** `keyboardOpen` is "a file is
   open", which is necessary and not sufficient. If producers hit the timeout
   message often, the honest fix is for `KeyboardPanel` to announce itself on
   the bus.

## Test state

`pnpm test`: **1,816 passing in 171 files** (1,749 in 167 before this work; 67
new across four new files, plus additions to `system.test.ts` and
`ToolCard.test.tsx`). Nothing existing was changed, skipped or deleted.

`pnpm typecheck`, `pnpm lint` and `pnpm build` are clean.

**Three failures pre-date this work and are not related to it.**
`app/api/usage/route.test.ts` (2) and `app/api/web/search/route.test.ts` (1)
fail on a clean checkout of `agent/frontdoor` too — they are date-dependent
(fixtures dated 2026-09-13 read on 2026-09-14). Verified by stashing.

| file | tests | what is asserted |
|---|---:|---|
| `lib/chat/surfaces.test.ts` | 31 | a step becomes the command the command line produces, with the control's line; **every example in the grammar block parses**; the keyboard's verbs on the keyboard's bus; good steps kept and the bad one named; seven real conversational sentences left to the model; every refusal in the control's own words; bars refused with no measured tempo, in three verbs; a rack row left to the rack when the rack is not listed and decided when it is; the block naming controls as controls; tempo, key and bandwidth only from a report, with the method; only the families that have a listener; `what is in bar 17` with lineage, and refused with no tempo; one lane read with its separator, its take and the record's own bars |
| `lib/chat/surfaceTools.test.ts` | 16 | the directive card carries the parsed command and the line; a refusal is reported and the rest still run; every step refused is an error carrying the vocabulary; no session says so; the schema's step bounds; a batch may not carry a directive; the card round-trips the NDJSON protocol and survives `JSON.stringify` so a row can hold it; export queues a job with the song in its params, names the zip and the held-back lanes, refuses an empty timeline and a record this library cannot open **without writing a job**, and attributes the key to its record or writes none |
| `components/chat/directive.test.tsx` | 7 | every step on its bus in order; one step's answer awaited before the next; a refusal stays a refusal; **an unheard step is reported, not silent**; the run carries on past it; the listener is dropped once a step settles; no steps, no emissions |
| `components/chat/sessionSnapshot.test.tsx` | 11 | the song, the transport and the grid carried; **no measured value leaves the browser**; each chain in the dock's words and the empty ones left out; the limiter with no loudness claim; the sounding candidate with `listed: false`; the keyboard claimed only on a file surface; an empty session packed as an empty song; a copy, so a later edit cannot change what was sent; the result parses against the route's own schema |
| `lib/chat/system.test.ts` | +3 | the session block present, after the files, and absent with no session; present with no file attached; the prompt names the three tools and says a queued export is not a finished one |
| `components/chat/ToolCard.test.tsx` | +2 | a directive renders each control's line, its bus and what was refused; a session card shows lanes, regions and the grid, or that there is no tempo |

## Known seams, for whoever is next

- **The grammar block is a second copy of the vocabulary — in one direction.**
  `GRAMMAR` in `lib/chat/surfaces.ts` lists forms the parser accepts, and a
  test runs **every example in it** through the parsers and fails if one does
  not parse. (It earned its keep immediately: it caught `propose melodic cuts`
  and a bare `cut`, neither of which the pads parser takes — the real forms are
  `propose cuts for melodic` and `cut it`. Reading around that also turned up a
  bare `stop` in the keyboard line, which the *session* parser takes first as
  the transport's stop; the keyboard's form is `stop recording`.)
  The direction that is still unchecked is the other one: a verb added to the
  parser and not to `GRAMMAR` is simply never reached by the model, though it
  still works when typed. That is a judgement about what is worth showing, not
  a bug, so it is not asserted.
- **The refusal wording is matched by hand.** `checkSessionCommand` uses the
  same resolvers as `components/shell/applyCommand.ts` and
  `components/processing/ProcessingProvider.tsx`, so the *decisions* cannot
  drift — but three sentences ("nothing in the session is called X.", the
  no-tempo line, "nothing is auditioning…") are literals in both places. They
  belong in `lib/session/commands.ts` as exported strings; that file is mine
  and `applyCommand.ts` is not, so moving them is one edit in each.
- **Directives never round-trip.** The model is told what a step *will* say,
  not what it *did*, because the client applies it after the turn has streamed.
  So the model cannot chain "move it, then read where it is" in one turn. A
  second turn reads the moved session correctly.
