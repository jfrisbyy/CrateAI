# HANDOFF_timeline.md

The song timeline — Surface 2 of `docs/PRODUCT_DIRECTION.md`, and step 5 of the
build order recorded there.

The rack answered "what could go under this". This answers the question after
it, which is the one the producer actually has to settle:

> **What is this song?**

A running multitrack view of the arrangement as it is built: lanes stacked,
regions on a timeline against a bar ruler, the playhead moving through it, and
direct manipulation — drag to move, drag an edge to trim, split, copy, mute,
solo, set gain, delete, undo. Built on the session transport that landed in
`docs/HANDOFF_session_transport.md`; nothing in the engine was changed.

**The line, kept.** In scope: arrangement and audition. Out of scope: EQ,
compression, automation lanes, plugin hosting. The test applied to every
control that was tempting: *does this help the producer decide what the song
is?* Moving a region does, splitting one does, a region's own trim does. A
compressor does not, and there is not one.

## Files

```
web/lib/session/                       the song, as data and as arithmetic
  lineage.ts        RegionLineage: what a region is, and what an edit changes
                    about that (soundingSpan, sourceBars, lineageParts)     (+ test, 19)
  snap.ts           the grid: divisions, snapping, the ruler, bar labels    (+ test, 22)
  viewport.ts       zoom and scroll as arithmetic, and the cull             (+ test, 17)
  history.ts        undo, with labels and coalescing                        (+ test, 11)
  arrangement.ts    the state model and every edit as a pure function       (+ test, 46)
  reconcile.ts      what an edit means for audio already scheduled          (+ test, 21)
  songEdits.test.ts the whole loop — edit, reconcile, engine, undo          (test only, 9)
  commands.ts       extended with the arrangement verbs (edited)            (+ test, 32)
  types.ts          SessionRegion gained `lineage` (edited, additive)
  rack.ts           candidates gained `sourceBpm`; tiling attaches lineage (edited)
web/components/timeline/               the surface, deliberately thin
  SongSurface.tsx   the song, with the lane list as its narrow view
  TimelinePanel.tsx the timeline: ruler, lanes, regions, playhead, keyboard
  TimelineRuler.tsx the bar ruler and the CSS grid behind the lanes         (+ test, 6)
  LaneHeader.tsx    a lane's head: mute, solo, level, restack, remove       (+ test, 7)
  RegionBlock.tsx   one region: body drags, two edges trim                  (+ test, 7)
  RegionInspector.tsx  what the selected region is, with editable numbers   (+ test, 8)
  timelineEvents.ts the bus that lets a sentence zoom the same control
web/components/shell/
  SessionProvider.tsx  arrangement, edit, undo/redo, snap, selection (edited)
  Workspace.tsx        the song surface, and the arrangement verbs (edited)
  TransportBar.tsx     the lane button now opens the song (edited)
supabase/migrations/
  20260913001000_song_arrangement.sql   written, NOT applied
```

`analysis/**`, `web/app/api/**`, `web/lib/billing/**`, `web/lib/chat/**` and
`web/lib/session/{engine,schedule,time,webAudio}.ts` are untouched. No bug was
found in the engine; it did everything the timeline needed.

## 1. The state model, and why

```ts
interface Arrangement { tracks: SessionTrack[]; regions: SessionRegion[] }
```

That is the whole of it. Regions carry their own `trackId` rather than nesting
inside a lane, because it is the shape `planWindow` already schedules over —
re-nesting twice a frame would be work for nothing — and because a move to
another lane is then one field rather than two splices.

Three decisions sit under it.

**The engine stays the source of truth; the arrangement is a view of it.**
`arrangementOf(snapshot)` takes the lanes and regions out of an engine
snapshot, the pure functions in `arrangement.ts` return a new one, and
`planReconcile` turns the difference back into engine calls. Nothing keeps a
second copy of the song in sync with the first, which is the usual way a
timeline and its audio end up disagreeing.

**The audition lane is not part of the song.** The rack's ephemeral lane comes
and goes while a producer decides; if it were in the arrangement, undo would
walk back through thirty auditions to find the drag they actually wanted. So
`arrangementOf` holds ephemeral lanes out and `applyArrangement` puts them back
when the engine is handed the result. Asserted both ways.

**Every edit returns a new arrangement, or the one it was given.** Identity is
meaningful: `session.edit` compares with `sameArrangement` and records nothing
when a drag ended where it started, so a click on a region does not fill the
undo stack.

## 2. How edits reconcile with audio already scheduled

The engine schedules 250 ms ahead. When a producer lets go of a region, some of
what they just changed may already be in the audio thread's hands with an
absolute start time on it. `reconcile.ts` is the answer, and it is arithmetic
over two snapshots, so the case that matters is asserted in node at exact
times rather than hunted for by ear.

**The mechanism was already there.** `engine.setTrackRegions` stops one lane,
drops that lane's keys, swaps its material and re-plans immediately; everything
else keeps playing and the new material joins at the point in the bar the
transport is already on. It is the rack's A/B. Reconciliation is not about
inventing a mechanism, it is about using the smallest number of them.

`planReconcile(previous, next, flight)` returns data, not effects:

| what changed | what the engine is asked to do |
|---|---|
| a region moved, trimmed, split, copied, deleted | `setTrackRegions` on **that lane only** |
| mute, solo, level, name | `setTracks` — gain nodes and a list; nothing stops |
| lane order | `setTracks` — inaudible |
| a lane added or removed | `setTracks`; a removed lane is already stopped by it |
| nothing | nothing (`plan.empty`) |

The consequences, each with a test:

- **A drag on the drums cannot interrupt the bass.** A lane whose regions are
  structurally identical is never handed anything, so it is never stopped.
- **An edit inside the lookahead window re-plans once, at the new place, with
  the right offset.** A region moved a second later while it is sounding comes
  back `joined`, at the playhead, playing the sample it should be playing —
  not restarted from its head, not started twice when the next tick comes
  round.
- **An edit beyond the lookahead touches nothing now** and is scheduled at its
  new place when the playhead reaches it, starting at its own head.
- **Muting while playing stops nothing at all** — no `stopTrack`, no `start`,
  one gain node moved.

**What is honestly imperfect.** A lane is the smallest thing the engine can
replace, so moving a region at bar 33 stops the lane that is sounding at bar 4
and re-joins it. The re-join is sample-exact (the offset is recomputed from the
transport position), so there is no drift and nothing is lost; the cost is the
2 ms declick at the seam — a dip, not a stutter. The plan measures this rather
than hiding it: every `LaneUpdate` carries `interrupts` and names its
`bystanders`, the regions that were interrupted only because of the
granularity. If that dip turns out to be audible in a real session, the fix is
a `stopRegion(regionId)` on `TransportBackend` and a per-region key drop in the
engine — about fifteen lines, in a file this seam was told not to touch, and
the bystander count is the number that says whether it is worth it.

## 3. The grid and the snapping rules

`snap.ts`. Bar arithmetic comes from `time.ts` (bar 1 is second zero, which is
the session's own frame) and beat/sixteenth arithmetic from `lib/pads/grid.ts`,
which the pads recorder already uses — so a recorded take and a dragged region
agree about where the sixteenth is. Nothing was reinvented.

- Divisions: **bar, beat, eighth, sixteenth, off.** The producer's choice, in
  the toolbar and in a sentence (`snap to 16ths`).
- `divisionSeconds` returns **null** with snapping off *and* when the session
  has no measured tempo. That second null is the important one: a session with
  no tempo has no bars, and `loopForBars` already refuses to invent one.
- **Moves and trims snap to an absolute position** (`snapTime`), so dragging a
  region that arrived off-grid pulls it onto the grid, which is what "snap to
  bars" means.
- **Nudges are relative** (`nudgeRegion`), so an arrow key moves a region by
  exactly one division and keeps whatever offset from the grid it already had.
  With snapping off a nudge is a sixteenth, or a tenth of a second with no
  tempo at all — a nudge that did nothing would be worse than one that is
  approximate, and the readout says where it went.
- **The ruler draws what fits.** Bars always; every 2nd, 4th, 8th bar as the
  song is zoomed out; beats only when a beat is more than one label apart;
  sixteenths only below that. Without a tempo it rules in **seconds**, so the
  timeline is usable before anything with a measured tempo has been committed.
- **The grid behind the lanes is two CSS repeating gradients**, not a line per
  division. At full zoom over a four-minute song that is two background layers
  instead of forty thousand elements.

## 4. How lineage survives editing

This is the part a normal DAW does not have, and the reason the timeline is
worth building here rather than being a worse Ableton.

`RegionLineage` rides on the region (`SessionRegion.lineage`) and is written
once, when material lands on the timeline (`lineageOfCandidate`, attached by
`tileCandidate`, so a region is never on the timeline without it). It carries
the record, the parent record, the stem, **which separator made it**, the take
(`takeStartS`/`takeEndS`), the downbeat, the source's length and measured
tempo, the transforms, and the rack row it arrived as (`candidateId`,
`reason`, `confidence`).

**Nothing rewrites it.** Every edit in `arrangement.ts` copies the region with
a spread, so move, trim, split and copy all carry it through untouched. There
is a test that moves, trims, splits and copies one region and asserts all three
resulting regions still name the record, the stem and the separator, and that
`takeStartS` never moved.

**What an edit *does* change is derived, not stored.** `soundingSpan(region)`
is `offsetS` to `offsetS + durationS × rate` — which seconds of the record are
actually sounding, after every move and trim, accounting for the fact that a
resampled region eats the source faster than the timeline. `sourceBars` counts
those seconds in the record's own bars from its own downbeat. So:

- Trim a bar off the front and the line changes from "bars 1–4" to "bars 2–4",
  because that is what it now is.
- Move the region to bar 33 and the line does not change, because moving it did
  not change which bars of the record it is.
- Split it and both halves say the right half of the truth.
- Copy it and the copy says the same thing as the original.

A pickup is reported as bar 0 rather than clamped to bar 1, because that is the
truth. The three transforms are kept apart, because they are different things a
producer needs to tell apart: `cents` (pitch moved by a render, time held),
`stretch` (time moved by a render, pitch held) and the region's own `rate`
(resampling at playback, where pitch and time move together the way a sampler
does). Only the third happens in the browser today; the inspector reports the
cents a rate moves, computed, with the explanation in its title.

Every claim in the inspector has its measurement behind it in a `title`. There
are no bare numbers.

## 5. What undo covers

A tested pure reducer (`history.ts`), the shape the panel's history already
uses: a cursor, labels, a bounded stack of 64, and coalescing.

**Covered:** move, trim head, trim tail, split, duplicate, delete, a region's
own level, taking a lane out, restacking lanes, and committing a candidate from
the rack (so a candidate kept by mistake is one press away from being gone).
Every entry is labelled in the words the control uses, and the button says
"Undo trim the start" rather than "Undo".

**Coalesced:** a run of arrow-key nudges on the same region inside 700 ms is
one step, not forty. A drag never reaches the stack until the pointer goes up.

**Not covered, on purpose:** mute, solo, lane level and master level (they
change no material and are their own toggle back); the transport and the
locators; auditioning; zoom, scroll, snap and selection. Those are a producer's
view or a producer's monitoring, not the song.

**Kept honest:** when the song changes for a reason that is not an edit — a
lane arriving from the rack, a decode landing — the stack's idea of "now" is
replaced rather than pushed, so undo still walks back past it and the engine's
echo of an edit is never recorded as a second edit.

## 6. Zoom, scroll and not re-rendering

`viewport.ts` is all of the maths and is tested without a DOM.

- **Zoom holds the music still.** Zooming with the pointer over bar 33 leaves
  bar 33 under the pointer; the scroll is solved for rather than accumulated,
  so zooming in and back out returns to the same place instead of drifting.
  Asserted.
- **Only what is on screen is drawn.** `regionsInView` culls; a song of four
  hundred regions draws the ten that fit. Asserted on four hundred.
- **A drag re-renders one block.** `previewDrag` computes only the region being
  dragged, without rebuilding the array; every other `RegionBlock` is memoized
  and its props (handlers, the peaks lookup, the content-space viewport) are
  stable across renders.
- **The playhead never goes through React.** It is written straight to a
  `transform` on an animation frame. The bar readout is its own component with
  its own 10 Hz frame, so a line of text does not re-render the song.
- **Scrubbing the ruler is throttled to 20 Hz**, because a seek stops every
  source and re-plans.

Scrolling is the browser's own (one `overflow: auto` container, sticky lane
headers and a sticky ruler), so the wheel, the trackpad and the scrollbar all
behave the way they do everywhere else.

## 7. Everything the mouse can do, a sentence can do

The rule from the direction document, and the sentence moves the *same*
control: the parser produces a command, the shell runs the same pure function
the pointer runs, on the same grid, through the same undo stack. There is no
second code path by which a sentence can change the arrangement.

| sentence | control |
|---|---|
| `show the song`, `open the timeline` | the panel |
| `move the drums to bar 17`, `move it to 12s` | drag the block |
| `trim the drums to 4 bars`, `make it 8 bars long` | drag the right edge |
| `duplicate it`, `repeat the drums` | Duplicate |
| `split it here`, `split the drums at bar 9` | Split at playhead |
| `delete it` | Delete / Backspace |
| `remove the horns`, `take the bass out` | the lane's × |
| `snap to bars`, `snap to 16ths`, `no snap` | the snap segment |
| `zoom in`, `zoom out`, `fit the song` | the zoom buttons |
| `undo`, `redo`, `take that back` | Undo / Redo |

**The selection is shared**, not the panel's: "move it to bar 17" means the
region the mouse has selected, because otherwise the two halves would be
pointing at different things.

**Ambiguity is answered, never guessed.** A pronoun means the selection. A
lane's name means that lane's region when it has exactly one, or the selection
when the selection is already on it. Otherwise the echo says *"Horns has 2
regions. Click the one you mean, then say it again."* The parser stays narrow
in the same way the existing one does: `remove the vocals from this record` is
a separation request and reaches the model intact, and there are tests that run
real conversational sentences (`why did you move the drums to bar 17`,
`trim the fat from this arrangement please`, `what's in bar 17`) and assert
every one is left alone.

## 8. The persistence shape

`supabase/migrations/20260913001000_song_arrangement.sql`, **written and not
applied**.

OPEN_QUESTIONS 38 assumes tables rather than a blob, "because 'what's in bar
17' should be answerable". These are those tables, and the shape is the
in-memory model, so persisting a session is an insert rather than a redesign:

- `song_sessions` — the song and its grid. `bpm` is nullable and a null means
  the session has no measured tempo and therefore has no bars; nothing may
  invent one to fill it in. The producer's snap choice lives here, because it
  is how they work on *this* song rather than a browser preference.
- `song_tracks` — a lane, with its `position` (order is the producer's), its
  mix, and its provenance line.
- `song_regions` — `start_s`, `duration_s`, `offset_s`, `gain`, `rate`,
  `source_file_id` as a real column, and `lineage` as one jsonb.

Two choices worth defending:

**`offset_s` is stored separately from `start_s`.** That is the whole head-trim
/ tail-trim distinction, and a schema that stored only "start and length" would
lose it on the first reload.

**The record's own bars are not stored.** They are derived from `offset_s`,
`duration_s`, `rate`, `downbeatS` and `sourceBpm`, so that trimming a region
changes the bars it claims rather than leaving a stale number in a column.

The queries the indexes are shaped for are written out at the top of the
migration: *what is in bar 17*, *which records is this song built from and how
were they separated*, *every region that came from one record* (which is also
the takedown path). RLS is the same `auth.uid() = user_id` on every table and
every operation as the rest of the schema.

`describeBar(arrangement, bar, tempo)` and `regionsInBar` already exist as pure
functions and are tested — they are what a chat tool would call. Wiring that
tool is `web/lib/chat/**`, which is outside this seam.

## 9. What is tested

`pnpm test`: **122 files, 1155 tests, all passing** (967 in 111 before this
work; 188 new). Nothing existing was changed, skipped or deleted; two existing
test fixtures gained a field (`sourceBpm`) and the command-line test file
gained groups.

| area | file | what is asserted |
|---|---|---|
| lineage | `lib/session/lineage.test.ts` (19) | the record, stem, take and separator carried; the three transforms kept apart; which seconds are sounding after a resample; bar numbers moving on a trim and *not* on a move; a pickup named as bar 0 rather than clamped; a record in another metre; a detail behind every label |
| the grid | `lib/session/snap.test.ts` (22) | every division; no division with snapping off *or* with no measured tempo; nearest / floor / ceil; the keyboard's step and its fallbacks; the ruler's density at four zooms; no two lines on one second; labels every 2nd then 4th bar; a seconds ruler with no tempo; bounded tick count; "bar 17.2" |
| zoom and scroll | `lib/session/viewport.test.ts` (17) | the second under the pointer held still; in-and-out returning to the same place; the zoom floor and ceiling; fitting an empty song and an eight-hour one; never scrolling before bar 1; room past the end; the playhead followed only when it leaves the screen; culling, including 400 regions down to 10 |
| undo | `lib/session/history.test.ts` (11) | order, labels, redo, a new edit truncating the forward history, coalescing by key and by time, not coalescing across regions, the bound, replacing the present without a step |
| the edits | `lib/session/arrangement.test.ts` (46) | move keeps the offset and lands on the grid; trim head moves start+offset+duration together and trim tail only duration; neither reveals audio the source does not have; a resampled trim advances the offset by `delta × rate`; split is continuous and both halves keep the lineage; copy keeps the lineage; ids stay unique and deterministic; lanes; drag intents and the one-region preview; the audition lane held out and put back; "what is in bar 17" |
| reconciling | `lib/session/reconcile.test.ts` (21) | what is in flight, including the wrap at the end locator and a loop shorter than the lookahead; only the changed lane handed over; bystanders named; nothing interrupted when the lane is silent or the transport is stopped; mute moving a node and stopping nothing; **an edit inside the lookahead re-planned once at the new place with the right offset**, not started twice, not touching other lanes |
| the whole loop | `lib/session/songEdits.test.ts` (9) | edit → reconcile → engine → undo over the real engine: undo restoring all three numbers of a trim, a run of nudges as one step, a committed lane undone out of the engine, three edits without the transport stopping, new material playing on this pass |
| the sentence | `lib/session/commands.test.ts` (32, 15 new) | every arrangement verb; eight conversational sentences left alone; a line for every command; which region a sentence means, including the two-region refusal |
| the surface | `components/timeline/*.test.tsx` (28) | the lineage line on a region and its bars after a trim; two separate trim handles with what each does; handles dropped on a sliver; the inspector's claims, their measurements, and its editable bar numbers disabled without a session tempo (while the *record's* bars survive); the ruler's bar labels at the right pixels; a seconds ruler with no tempo; the grid as gradients; the lane's mute/solo/level and their pressed state |

`pnpm typecheck`, `pnpm lint` and `pnpm build` are clean.

## 10. What only a real browser session can confirm

There is no browser here and no signed-in session. In order:

1. **A region drags.** Pointer capture is taken on the scroll container rather
   than on the block, so a fast drag that leaves the block keeps tracking.
   Confirm a drag that goes outside the panel, and that releasing outside still
   commits the edit.
2. **A drag across lanes.** The lane under the pointer is found from rectangles
   measured once at the start of the drag. Confirm it is still right after the
   panel has been scrolled vertically mid-drag — if not, re-measure on scroll.
3. **The trim handles are grabbable.** They are 2–8 px wide, scaled to the
   region. Confirm at a zoom where a region is ~40 px that the head handle can
   be hit without the body taking the drag, on a trackpad and on a mouse.
4. **The 2 ms seam.** Move a region at bar 33 while bar 4 is playing on the same
   lane and listen to the lane that was already sounding. The maths says it
   re-joins at the right sample; the ear decides whether the declick dip is
   audible and therefore whether a per-region stop is worth adding to the
   engine (section 2).
5. **Trimming while it plays.** Trim the tail of the region under the playhead
   and confirm it stops where the new edge is, on this pass, without a click
   and without moving.
6. **Snapping feels right.** Drag with `bars` and confirm the block lands where
   the eye expects rather than one bar early; then `1/16` at a high zoom.
7. **The sticky header and ruler.** They are `position: sticky` inside one
   scroll container. Confirm the lane heads stay put when scrolled right, the
   ruler stays put when scrolled down, and the playhead passes *under* the
   heads rather than over them (it is `z-[5]`, the heads `z-10`).
8. **Follow.** With Follow on, confirm the view scrolls when the playhead
   leaves the right-hand 15 % and that it does not fight a producer scrolling
   by hand. If it does, turn Follow off while the pointer is down.
9. **Scrubbing.** Dragging the lower half of the ruler seeks at 20 Hz. Confirm
   it sounds like a scrub rather than a stutter, and that the locator band
   (the top ~8 px) is not hit by accident when aiming at the playhead.
10. **The keyboard.** Click a region, then arrows, Delete, Escape, Cmd/Ctrl+Z,
    Cmd/Ctrl+Shift+Z. The global map in `lib/keys/commands.ts` ignores
    modifier combinations and does not claim arrows or Delete, so there should
    be no collision — confirm, and confirm typing in the inspector's number
    boxes does not nudge the region.
11. **Zoom over a real song.** Zoom to `Fit` on a four-minute arrangement, then
    to full zoom, and watch for jank while scrolling. The cull and the gradient
    grid are what should make this cheap; if it is not, the next thing to
    virtualise is the lane rows.
12. **A big arrangement.** Two hundred regions across a dozen lanes: drag one
    and confirm only it moves, and that the frame rate holds.
13. **The sentences, in anger.** Type each row of the table in section 7 and
    confirm the visible control moves, the echo matches, and undo puts it back.
14. **Below 1000 px.** The timeline has not been tried narrow. The `Lanes`
    view is the fallback and is the same controls; confirm the segmented
    control is reachable and consider switching to it automatically under
    about 520 px.
15. **A region whose source is still decoding.** It draws with no waveform and
    says "decoding". Confirm it fills in when the samples land, and that
    editing it in the meantime still works (the arrangement does not need the
    audio; only the tail-trim limit does, and it falls back to the library
    row's duration).

## 11. Decisions taken, and why

- **The lane is the unit of reconciliation.** Section 2. The alternative needed
  a change to `engine.ts`, which this seam was told not to touch without a
  genuine bug, and there was none.
- **Overlapping regions on one lane are allowed.** The scheduler keys pieces by
  region and pass, so two overlapping regions both sound, which is what a
  producer layering two takes on one lane means. A DAW that trims the one
  underneath would be making an arrangement decision for them.
- **Mute, solo and level are not undoable.** They change no material and are
  their own toggle back. Putting them on the stack would make undo mean "the
  last thing I touched" instead of "the last thing I changed".
- **`beatsPerBar` is four.** Nothing in the pipeline measures metre yet, and
  four is the assumption the rest of the product already makes. The lineage
  carries the field so a measured metre drops straight in; `sourceBars` already
  counts a three-four record correctly and there is a test for it.
- **A candidate's `sourceBpm` is the record's own measured tempo**, taken from
  the analysis, never derived from the fit ratio. A tempo nobody measured is
  not a tempo, and a region whose record has none simply says its seconds
  instead of its bars.
- **Split is in, crossfade is not.** Splitting is an arrangement decision
  ("drop that bar"); a crossfade is production. The split join is
  sample-continuous, so playing across it sounds like nothing happened.
- **The song and the lane list are one surface with two views**, not two
  surfaces, because the panel's rule is one surface at a time with history and
  a song that took two entries in that history would be a mess.
- **The timeline scrolls natively.** One `overflow: auto` container with sticky
  headers, rather than a synthetic scrollbar, so the wheel, the trackpad,
  shift-scroll and the keyboard all behave the way they do everywhere else.

## 12. What is not done

- **The chat cannot see the song yet.** `describeBar` and `regionsInBar` are
  the functions a `read_arrangement` tool would call, and OPEN_QUESTIONS 39's
  "compact summary of tracks and regions, with a tool to read any region in
  detail" maps onto `Arrangement` and `lineageParts` directly — but the tool
  lives in `web/lib/chat/**`, outside this seam.
- **Nothing is persisted.** The migration is written and not applied, and
  nothing reads or writes those tables yet.
- **No lane can be created empty**, and material cannot be dragged from the
  rack onto the timeline. Commit makes a lane; the timeline then arranges it.
  A drag from a rack row to a lane is the obvious next affordance.
- **No region-level fades, no crossfades, no groups, no markers beyond the
  locators.** Fades are the first one of those that is arguably arrangement
  rather than production; the rest are not.
- **Per-track corrective processing** (EQ, filters, tuning) is still the phase
  after this one. The graph has the place for it between the piece gain and the
  track gain, and the command bus this uses is the one a chat-driven EQ will
  need.
- **Export.** Nothing renders the arrangement to a file or a tempo map.
- **`RankCorrection` still goes nowhere.** Committing a candidate records one
  in the session as before; it needs a route.
