# HANDOFF_session_transport.md

The session transport, the candidate rack and the adaptive layout — Surfaces 1
and 3 of `docs/PRODUCT_DIRECTION.md`, and the Phase 11 foundation both of them
and Surface 2 stand on.

Built around one rule from the direction document:

> A result you cannot hear is not a result.

The concrete failure it comes from: a producer asked for drums, got a ranked
table of five records with percussive fractions, and could not play any of
them. The system picked correctly and the answer was still rejected, because a
ranked table is how a machine decides and pressing play is how a producer
decides. Everything below exists so that every ranked answer arrives as a row
with a play button that puts the candidate *under what is already playing*.

## Files

```
web/lib/session/                        the transport. no React, no Web Audio except webAudio.ts
  types.ts          SessionTrack, SessionRegion, TransportState, ScheduledPlay,
                    TransportBackend, Ticker, the four constants (lookahead, tick, eps)
  time.ts           positionAt, passAt, segmentsInWindow, wallForPosition,
                    clampToLoop, bars (secondsPerBar, barToSeconds, loopForBars, barAt)  (+ test)
  schedule.ts       planWindow, pieceFor, planKey, rateOf, sourcesOf, contentEnd        (+ test)
  mix.ts            anySoloed, audible, trackGain, mixOf, gainFromDb, dbFromGain        (+ test)
  decodeCache.ts    DecodeCache<B>: LRU + byte budget + pins + in-flight dedupe         (+ test)
  engine.ts         SessionEngine over a backend and a ticker; intervalTicker           (+ test)
  webAudio.ts       WebAudioBackend: the only file that touches Web Audio
  rack.ts           the rack's data contract, its builders, the audition tiling         (+ test)
  commands.ts       sentence -> SessionCommand, resolveTarget, describeCommand          (+ test)
  fakes.ts          ManualClock, ManualTicker, FakeBackend, fakeDecoded (tests only)
web/lib/audio/
  peaks.ts          wavePath, spanBox, markerX: a rack row's waveform from stored peaks (+ test)
  decode.ts         + fetchAndDecode(url): decode with no cache of its own (edited)
web/components/rack/
  RackPanel.tsx     the rack: header, A/B controls, rows, the audition playhead
  CandidateRow.tsx  one candidate: waveform, downbeat play, measurement, provenance, commit
  PeaksBar.tsx      the row's waveform with its region marked
  useRack.ts        one ask -> rows, from /api/compat, /api/loops, /api/search
  rackEvents.ts     the `crateai:rack` window event and RackRequest
web/components/shell/
  SessionProvider.tsx  the engine, the cache and the session as React state
  Workspace.tsx        the adaptive layout (rewritten)
  TransportBar.tsx     one transport strip for the whole session
  SessionPanel.tsx     the lanes: mute, solo, level, provenance, remove
  surfaceStack.ts      the panel's history and the divider, as a pure reducer     (+ test)
  sessionCommands.ts   the bus between the chat's command line and the controls
  TopBar.tsx           library and panel toggles (edited)
web/components/chat/
  ChatPane.tsx      the command line: parse first, model second, echo underneath (edited)
```

Nothing outside those paths was touched. `analysis/**`, `supabase/migrations/**`,
`web/app/api/**`, `web/lib/chat/**` and `web/lib/types/db.ts` are untouched.

## 1. The engine, and why it is shaped this way

There are three layers, and the split is the point.

**Pure scheduling** (`time.ts`, `schedule.ts`, `mix.ts`). Given a transport
state, a set of regions and a window of clock time, `planWindow` returns one
instruction per buffer source to start: when on the clock, from which second of
which source, for how long, at what rate and gain. No I/O, no audio, no React.

**The engine** (`engine.ts`). Holds the state, runs the lookahead, and talks to
two injected things: a `TransportBackend` and a `Ticker`. It never computes a
time itself.

**The adapter** (`webAudio.ts`, 189 lines). Owns an `AudioContext`, a master
gain, one gain node per lane, and one `AudioBufferSourceNode` per scheduled
piece. It makes no decisions; it only turns a `ScheduledPlay` into nodes.

The reason for that shape is the reality check in the brief: there is no
browser here. With the decisions in pure functions over an injected clock, the
loop wrap, the A/B swap, the mid-region join and the late decode are all
asserted in node, at exact times, in milliseconds. What is left in the browser
is node plumbing thin enough to read in one sitting.

The graph is three deep and no deeper:

```
AudioBufferSourceNode -> piece gain -> track gain -> master -> destination
```

The piece gain carries the region's trim and a 2 ms fade at each end. That
fade is not taste, it is the click: a region cut at a locator or at a seek
almost never lands on a zero crossing. `renderLoop.ts` still does the real
equal-power crossfade when it is *making* a file; this is playback, where the
material has to stay exactly where the producer put it.

### The playhead is derived, never stepped

`TransportState` stores an anchor (`anchorS` at `anchorWall`) and the locators.
The position is a function: `positionAt(transport, clock)`. Two consequences:

- The drawn playhead and the audio cannot drift apart, because both read the
  same function off the same clock.
- Loop repeat *n* lands at `anchorWall + n · loopLength` exactly, computed from
  the anchor rather than accumulated a tick at a time. A test runs a thousand
  passes and asserts the position to nine decimal places.

## 2. How the scheduling stays accurate

Two rules, both tested.

**Absolute times, scheduled ahead.** Every piece carries an absolute clock
time, handed to `AudioBufferSourceNode.start(when)`, which the audio thread
honours to the sample. The 60 ms timer only has to be *early*, never punctual:
it schedules 250 ms ahead, so a tick can be 190 ms late and lose nothing.
There is a test that ticks at 190 ms intervals and asserts the repeats still
land exactly one loop length apart. No musical timing is ever taken from
`setTimeout`.

**One key per piece.** A piece's identity is `regionId|pass` — one region can
only sound once per pass of the loop — so overlapping ticks re-derive the same
keys and the engine drops the duplicates. A test runs 140 overlapping windows
across five passes and asserts that every key is unique and none is missing.

Three cases fall out of the same arithmetic rather than being special-cased:

- **A loop that wraps inside a region.** The region is cut at the end locator
  and its head starts again on the next pass, from the same offset.
- **A seek into the middle of a region.** The piece's offset advances with its
  clipped start, so it plays the right samples instead of restarting.
- **A track that is still decoding.** Its source is not ready, so no key is
  recorded and the region is reported as `waiting`. When the samples land, the
  same piece is planned again — now with a start in the past, trimmed to the
  clock — and the lane joins *in progress*, at the right place in the bar. The
  cache's `onReady` calls `engine.sourceReady()` so this happens immediately
  rather than on the next tick.

One bug the tests caught during the build, worth knowing about: pieces were
originally clipped to the *lookahead window* rather than to the pass, so a four
-bar region became the first 250 ms of itself and the rest was never scheduled.
`Segment.limitS` now carries the pass's real end separately from the window's,
and the start is bounded by the window while the end is bounded by the pass.
A second one: a float hair below the end locator could leave the segment walk
making 1e-14 of progress per iteration. The overshoot is clamped to zero (so
the wrap lands exactly on the start locator) and the walk has a hard iteration
guard.

### Mute, solo and gain never restart anything

The mix moves gain nodes; the sources keep running. Unmuting four bars later
drops back in on the beat instead of restarting the region. That is why
`mix.ts` is separate from `schedule.ts` — audibility is not a scheduling
decision. Solo is exclusive across the session, mute wins over solo on the same
lane, and a muted lane keeps its fader value so unmuting restores it.

### The A/B, which is the reason the rack exists

`engine.setTrackRegions(trackId, regions)` replaces one lane's material:
it stops that lane's sources, drops that lane's keys, swaps the regions and
re-plans immediately. Everything else keeps playing; the transport never stops.
The new candidate joins where the bar already is, and on the next pass of the
loop it starts cleanly from its own downbeat. Both halves are asserted.

## 3. The memory strategy

Decoded PCM is the expensive thing: four minutes of 44.1 kHz stereo is 81 MB of
Float32. A dozen lanes of that is most of a tab.

`DecodeCache<B>` is bounded from the start:

- **A byte budget**, default 384 MB (about nineteen minutes of stereo).
  `decodedBytes(channels, frames)` is the accounting.
- **Least recently used goes first**, and "used" means *asked for*, not decoded.
  `peek` reads without touching the order, so a readout cannot change what
  survives.
- **Pins.** The session pins exactly the sources its regions point at
  (`cache.setPins(engine.sources())` after every change). The rack pins only
  the candidate currently auditioning. That is the difference between "this is
  in the song" and "I am listening to this", and it is why a rack can hold
  thirty rows: the rows carry stored peaks, not samples.
- **Lazy always.** Nothing decodes because it appeared. A rack row decodes on
  hover or focus (`session.warm`), or on first play. `web/lib/audio/peaks.ts`
  draws the row's waveform from `files.peaks`, which the analysis already
  stored, so thirty thumbnails cost no audio at all.
- **In-flight dedupe and remembered failures**, so two callers share one decode
  and a dead URL is not re-fetched on every tick. `forget` clears a failure,
  which is what a retry button does.
- When pins alone exceed the budget the cache goes over rather than dropping
  something the session needs, and says so (`overBudget`); the transport strip
  shows the megabytes held.

The cache is generic in the buffer type, so the whole of it is exercised in
node against a stub and the browser just passes `AudioBuffer`.

`lib/audio/decode.ts` gained `fetchAndDecode(url)` — decode with no cache of
its own — so the session's budgeted cache is not shadowed by the three-item
cache the loops tab uses for the single open file.

## 4. The rack's data contract

`RackCandidate` (in `web/lib/session/rack.ts`) is built around what a row has
to say for itself without another round trip:

| field | what it is |
|---|---|
| `audio` | `{ fileId, startS, endS, downbeatS }` — what to decode, which span, **where play starts**. `downbeatS` is the whole point: a break that starts at the file's zero arrives late by whatever silence the upload had. |
| `reason` | one line in the product's existing vocabulary, from the same code the Fits-with panel uses (`describeMatch`), never re-worded. |
| `confidence` / `confidenceReason` | drives the hedge word (`lib/report/hedge.ts`) and the confidence dot, unchanged from the rest of the product. |
| `measurements[]` | `{ label, method, confidence }` — "92.0 BPM", "+3.9% to fit", "relative minor", "62% alike", each with the measurement behind it in its title and its own dot. |
| `provenance` | file id and name, the span in seconds, the file kind, the stem name, **which separation model**, and the parent record. |
| `fit` | `{ rate, note, quality, semitones }` from the same octave fold and thresholds as `/api/compat`, so the rack and the panel can never disagree about a pair. |
| `peaks`, `fileDurationS` | the row's waveform, with no decode. |
| `rank` | where the machine put it. A suggestion. |

Three builders, all pure, all fed by routes that already exist:

- `candidateFromMatch` / `rackFromCompat` — `/api/compat`, "what in my crate fits this".
- `candidateFromLoop` / `rackFromLoops` — `/api/loops`, the finder's ranked loops.
- `candidateFromHit` / `rackFromSearch` — `/api/search`, which is the literal
  "find me drums" ask: the hybrid search already parses the tags and returns
  what matched, so the row can say why it is there without inventing anything.

No new backend and no fixtures pretending to be data. The one thing the rack
cannot yet show from a route is the separation model of a *candidate* that is a
stem of some other record (the `stems` rows are not fetched for arbitrary
files); the field is in the contract and populated wherever the caller has the
stem row. `RankCorrection` / `correctionFor` produce the principle-7 payload
when a producer picks the third row over the first — the session keeps them,
and nothing writes them yet because there is no route; see "What is not done".

### Solo against the session

`tileCandidate` lays a candidate across a span of the timeline: repeats of
`(endS - downbeatS) / rate`, from the locators, with the last repeat cut at the
end locator. Every repeat plays from the downbeat. `session.audition(c)` puts
that on one lane (`AUDITION_TRACK_ID`), under whatever is already playing, and
starts the transport if it is stopped; with no locators yet it makes them from
the candidate's own length, so a first audition loops on itself. Pressing play
on the next row is one `setTrackRegions` call: same bar, no stop, no gap.
`commit` promotes the same tiling to a lane of its own and frees the audition
lane.

The audition resamples to fit (`playbackRate`), which moves pitch with tempo
the way a sampler or a turntable does — honest, and what a producer fitting a
break expects. Real time-stretching with pitch held is a render on the compute
side; the direction document is explicit that the phase vocoder is not good
enough for the 0.73–0.85 ratios this product asks for, so playback does not
pretend to do it. The row shows the rate it is playing at.

## 5. The layout rules, as implemented

The page is a chat. Everything the router renders — a record's surface, the
account page — and everything the shell makes — a rack, the session's lanes —
is an object on a panel that slides in from the right while the chat narrows.
`/` renders no object, which is what makes the first screen a chat.

| rule from the direction document | where it lives |
|---|---|
| One surface at a time, with history; going back is a click, not a re-run | `surfaceStack.ts`, a pure reducer (push truncates the forward history like a browser, back and forward move a cursor, the same surface pushed twice updates in place). 18 assertions. The file surface stays mounted while another surface is shown, so coming back really is free. |
| The chat stays the command line | `lib/session/commands.ts` parses a sentence; `sessionCommands.ts` carries it to the shell, which moves the same control the mouse moves and sends back one line in the same words. |
| Resizable and dismissible | a draggable `role="separator"` divider (arrow keys work too), clamped to 28–74 % so neither side can be squeezed out, remembered in `localStorage`; Close collapses to the full-width chat and the history survives. |
| Nothing modal | the transport strip is outside the panes and always live. Auditioning does not block the chat; a chat turn streaming does not touch playback. The engine lives above the router, so navigating does not stop the audio. |

The command line is deliberately narrow: a sentence becomes a command only when
it is unmistakably one. "solo the drums", "loop bars 9 to 16", "turn the drums
down", "next", "play the third one under this", "keep it", "rack drums", "hear
what fits this", "close the panel". Anything with a conjunction or a question
word goes to the model untouched — there is a test that runs a list of real
conversational sentences ("find me drums that fit this", "why do these drums
sound muddy", "solo the drums and tell me why they are quiet") and asserts that
every one of them is left alone. When a command cannot be carried out the echo
says why ("nothing in the session is called horns", "the session has no
measured tempo yet, so it has no bars") rather than guessing.

Session bars: the session timeline starts at **bar 1, second zero**, and the
session adopts a tempo from the first rack that has one. `loopForBars` returns
null without a tempo rather than inventing one.

## 6. What is tested

`pnpm test`: **108 files, 929 tests, all passing** (779 before this work; 150
new). Nothing existing was changed, skipped or deleted.

| area | file | what is asserted |
|---|---|---|
| playhead and loop | `lib/session/time.test.ts` (20) | position derived from the clock, exact wrap at the locator, no drift over 1000 passes, playing into a loop from outside it, a loop behind the playhead never wrapping, degenerate locators ignored, segments tiling a window exactly, bars |
| scheduler | `lib/session/schedule.test.ts` (17) | region starts at its own offset, mid-region join, resampled offset arithmetic, cut at the locator and head again next pass, no double-start across 140 overlapping ticks, a 190 ms-late tick losing nothing, scheduling to the natural end not the window edge, a waiting source reported not played |
| engine | `lib/session/engine.test.ts` (23) | play/pause/resume/stop/seek, locators moving under the playhead, each region started once, repeats exactly one loop length apart, mute/solo/gain moving gain nodes with nothing stopped or restarted, the A/B swap stopping one lane and joining at the same bar, the next pass starting the new candidate cleanly, a late decode joining in progress at the right offset, the retry without any notification, lanes taking their material with them |
| memory | `lib/session/decodeCache.test.ts` (9) | one decode for concurrent callers, remembered failures and `forget`, LRU order and eviction, pins never evicted, over-budget reported rather than dropping the session, byte accounting, peek not disturbing the order |
| mix | `lib/session/mix.test.ts` (10) | solo exclusivity, two lanes soloed, mute winning on its own lane, faders kept while silent, clamping, dB round trip |
| rack | `lib/session/rack.test.ts` (26) | downbeat resolution and its fallbacks, the measurement/confidence/provenance of each builder, ranking and numbering, fit arithmetic including the half-time fold, tiling coverage with no gaps or overhang, resampled cycles, ids and lanes, commit provenance, the correction payload, stepping through a rack |
| command line | `lib/session/commands.test.ts` (17) | every command form, refusing inverted locators, not turning "what's up with these drums" into a fader move, leaving nine real conversational sentences alone, lane resolution by name then provenance, a line for every command |
| panel | `components/shell/surfaceStack.test.tsx` (18) | history, truncation, in-place updates, bounded history, dismiss and re-open, removal, route vs shell surfaces, divider clamping and pointer maths |
| waveforms | `lib/audio/peaks.test.ts` (10) | path geometry, resampling, silence still drawing, missing peaks, region placement and clamping |

`pnpm typecheck`, `pnpm lint` and `pnpm build` are all clean.

## 7. What only a browser can confirm

There is no browser and no signed-in session here. The first real session
should walk this list, in order:

1. **Sound at all.** Open a file, press play on a rack row. The `AudioContext`
   is created on that gesture; if it comes up suspended, `resume()` is called
   on every play — confirm the first click is not swallowed.
2. **The loop is seamless.** Loop four bars of one candidate for a minute.
   Listen for a click at the wrap (the 2 ms declick) and for any drift. The
   maths says the repeats are sample-exact; the ear is the check.
3. **The A/B.** With the session playing, press play on row 1, then row 2, then
   row 3, without stopping. Each should take over on the same bar, at the same
   point in the phrase, and the session underneath should not flinch.
4. **A late decode.** Audition a long record, then immediately a second one.
   The second should come in mid-bar the moment it decodes rather than waiting
   for the next pass.
5. **Mute and unmute while playing.** Nothing should restart; the lane should
   drop back in on the beat.
6. **Memory.** Audition twenty candidates and watch the megabyte readout in the
   transport strip and the tab's memory. Eviction should keep it near the
   budget and committed lanes should never be evicted.
7. **The panel while hidden.** The file surface is kept mounted with
   `visibility: hidden` (not `display: none`) so wavesurfer keeps a real width.
   Switch to a rack and back and confirm the waveform is still drawn correctly;
   if it is not, the fix is a resize call on re-show.
8. **The divider and the phone-width case.** Drag it; reload; confirm the split
   is remembered. The layout has not been tried below about 1000 px.
9. **The space bar.** `lib/keys/commands.ts` still routes space to the open
   file's wavesurfer transport, not to the session. With both on screen that is
   now ambiguous: decide which one owns it. (Suggestion: space drives the
   session when the panel is showing anything but a file.)
10. **The command line in anger.** Type the sentences; check that each one
    moves the visible control and that nothing conversational is swallowed.

## 8. Decisions taken, and why

- **The session is in memory, not in the database.** OPEN_QUESTIONS 38 assumes
  a table. The types here (`SessionTrack`, `SessionRegion`, with provenance on
  every lane) are already shaped like rows, so persisting them is an insert,
  not a redesign. Nothing was added to `supabase/migrations/**` because that is
  another agent's ground and the transport had to be right first.
- **Playback resamples; it does not time-stretch.** See section 4.
- **Muted lanes are still scheduled**, with their gain node at zero, so
  unmuting is instant and sample-accurate. It costs nodes, not CPU of any
  consequence, and it is what makes mute musical.
- **The rack ranks but does not re-rank.** Picking row three is recorded as a
  `RankCorrection` and kept in the session; wiring it to a `corrections` row
  needs a route (`web/app/api/**` is out of scope here).
- **The command line is narrow on purpose.** Swallowing a question would be
  worse than having no command line, so ambiguity always resolves to the model.
- **The wordmark still says CrateAI.** The rename to Cratebox is listed as
  mechanical in the direction document and touches legal pages, the login form
  and the chat's role labels, most of which are outside this seam.

## 9. What is not done

- **Surface 2, the song timeline.** Regions are not draggable, edges are not
  trimmable, and there is no arrangement view. `SessionPanel` is the minimum
  that makes "commit" mean something: lanes, mute, solo, level, provenance,
  remove. The engine is what the timeline will be built on; it already carries
  regions with offsets, gains and rates.
- **Per-track corrective processing** (EQ, filters, tuning). The graph has an
  obvious place for it — between the piece gain and the track gain — and the
  chat-driven-EQ requirement will need the same command bus this uses.
- **Session persistence** and the `corrections` write.
- **A rack from the chat's own tools.** Today a rack opens from the panel
  header or an explicit sentence ("rack drums", "hear what fits this"). The
  clean integration is a `rack` card returned by a tool in `web/lib/chat/**`
  so that "find me drums that fit this" produces rows the producer can play
  without having to know the word "rack". That file is outside this seam.
- **Stem provenance for compat candidates** (section 4).
- **Export.** Nothing here renders the session to a file.
