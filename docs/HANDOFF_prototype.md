# HANDOFF_prototype.md

The clickable prototype — step 7 of the build order in
`docs/PRODUCT_DIRECTION.md`:

> **A clickable, deployable prototype.** The layout running end to end with
> real interaction, so the owner can feel it rather than read about it.

It is at **`/demo`**. It signs nobody in, holds no keys, touches no table,
calls no API route and reaches no network. It builds and runs with an empty
environment, which is what makes it one click to a free Vercel tier.

**The one-line version: run `pnpm dev` in `web/` and open
<http://localhost:3000/demo>.** Then press the four numbered lines in the chat,
in order, top to bottom.

---

## 1. What it is, and what it is not

It is the product's own components on the product's own session engine. The
chat pane, the candidate rack, the song timeline, the transport strip, the
panel history, the divider, the command line — all of them are the files that
the app uses, imported unchanged. There is no second implementation of
anything, and where the prototype needed a seam it was cut in the shared file
rather than copied around (section 7).

**The only thing faked is the material.** There is no user audio and nothing
may be downloaded, so six records are synthesised in the browser and the
analysis values that describe them are written by hand. Everything computed
*from* those values — the ranking, the fit ratio, the reason on every row, the
confidence dot, the lineage on every region, the tiling, the scheduling — is
the real code doing the real arithmetic.

This is said on the page, twice: in the chat's opening paragraph and in the
footer of the crate rail. Nobody should mistake it for a separation result.

---

## 2. How to run it

**Locally.**

```
cd web
pnpm install        # once
pnpm dev
open http://localhost:3000/demo
```

No `.env.local` is needed. If you happen to have one, `/demo` still works: it
is in the middleware's public-path list, so a configured deployment does not
bounce a signed-out visitor to `/login` (section 7.6).

**Deployed.** Import the repo into Vercel, set the root directory to `web`,
and deploy with **no environment variables at all**. The build is proven to
succeed that way:

```
cd web
env -u NEXT_PUBLIC_SUPABASE_URL -u NEXT_PUBLIC_SUPABASE_ANON_KEY pnpm build
```

`/demo` comes out as `○ (Static)` — prerendered, 11.9 kB of route JS on top of
the shared bundle — so it costs nothing to serve. With the keys absent, `/`
renders the existing "CrateAI needs its Supabase keys" notice and `/demo`
renders the prototype; both were served and checked at 200 from a real
`next start` with the variables unset.

**Headphones or speakers, and the first click makes the sound.** A browser will
not start an `AudioContext` without a gesture, so nothing is audible until you
press something. The first numbered line is that press.

---

## 3. What to click, in order

The chat has four numbered lines at the bottom. They are the arc. Everything
else on the page is reachable at any time.

### 1 — "Put the four bars of Moonlight Highlife in the song."

The panel slides in from the right and the chat narrows. The song is on it:
one lane, one region, a bar ruler, a playhead that starts moving. The transport
strip at the bottom is now running, the locators are set to the record's own
four bars, and the session's grid says 92 BPM because that is the tempo on that
record's analysis.

Worth noticing before moving on:

- **The region starts at the record's downbeat, not at the file's zero.** The
  synthesised record has 0.31 s of silence in front of it, and the loop is
  still exactly four bars long.
- **Drag the divider** between the chat and the panel. Reload the page: it is
  where you left it.
- **Press Close in the panel header.** The chat goes full width and keeps its
  transcript. Press Panel in the top bar to bring it back.

### 2 — "Find me drums that fit it."

The rack. Five rows, each with a waveform, the measurement that earned it a
place, a confidence dot, and the record and separator it came from.

- **Press ▶ on row 1.** It plays *under* what is already playing, looped,
  from its own downbeat. The row shows the rate it is being resampled at.
- **Press ▶ on row 2 without stopping anything.** It takes over on the same
  bar. The bed does not flinch. Then row 3.
- **Rows 1 and 2 are the same fit to within a fifth of a per cent.** 88.5 BPM
  needs +4.0 % to sit at 92 and 95.5 BPM needs −3.7 %, which are 3.96 % and
  3.80 % from transparent — the same score once it is bucketed, so the
  embedding similarity breaks the tie. That is the case the ranking code was
  written around, and it is why the order is a suggestion rather than a verdict.
- **Row 3 is 174 BPM counted half-time as 87.** It is the heaviest of the five
  and the machine put it third. If you prefer it, that is the correction the
  ranking is supposed to learn from (`RankCorrection` is recorded in the
  session; nothing writes it anywhere, which is unchanged from before).
- **Row 5 has no measured tempo.** It says "I can't tell", the fit line is
  absent rather than guessed, and when you play it you hear what that costs:
  it re-triggers two thirds of a beat early on every pass. That row is the whole
  of principle 2 in one button.
- **Press Commit on whichever you like.** It becomes a lane of its own and the
  audition lane is freed. Then audition another one under it.

### 3 — "What loops are in Masquerade?"

A second rack, from a different builder: three loops ranked by the finder's
score, each with the components behind the score, each fitted to the session.

Then **press ← in the panel header**. The drums rack comes straight back,
nothing is re-fetched, and the transport never stopped. That is the panel's
one rule — one surface at a time, with history — working.

### 4 — "Show me the song."

The timeline, with whatever you have committed on it.

- **Drag a region** along its lane, and onto another lane. It snaps to bars;
  the segmented control changes the division.
- **Drag its left edge** to trim the start.
- **Click it** and read the line above the buttons: the record, the stem, the
  separator, which of the record's *own* bars it is, which seconds of it are
  sounding, and the resampling ratio with the cents it moves. Every one of
  those has its measurement in a tooltip.
- **Trim a bar off the front and watch that line change** from "bars 1–4" to
  "bars 2–4". It is derived from what is sounding, not stored from when it
  arrived. That is the thing a normal DAW throws away.
- **Split at playhead**, **Duplicate**, **Delete**, the lane's **M**, **S**,
  fader and **×**, and **Undo**, which is labelled with what it will undo.

### And then type at it

The command line is real and is the same parser and the same dispatcher the
app uses. Every one of these moves the control the mouse would have moved and
says what it did, in one line under the transcript:

```
play · loop bars 1 to 2 · solo the drums · turn the drums down · next ·
keep it · move the drums to bar 3 · trim it to 2 bars · split it here ·
snap to 16ths · undo · close the panel
```

Anything that is not unmistakably one of those is left alone — "why do these
drums sound muddy" is a question, not a mute — and the prototype answers it
with one honest line saying there is no model here.

**Do not press "Source" on a rack row.** It is the real button and it does the
real thing: opens `/f/<file id>`, the record's working surface in the app. That
route needs the library, so with no keys it lands on the setup notice and the
audio stops. Browser Back returns to the prototype. See section 8.

---

## 4. How the demo audio is made

`web/lib/demo/synth.ts`, and it is pure arithmetic — no Web Audio, no browser —
so all of it runs and is asserted in node, the same way `lib/session` is.

- **Voices.** A kick is a sine with a 28 ms pitch fall from 116 Hz to 47 Hz,
  an exponential amplitude decay and a click on the front. A snare is two body
  tones under high-passed noise. A hat is noise through two high passes with a
  metallic ring on top. A bass is three harmonics through a one-pole low pass
  that closes with the envelope. A Rhodes key is a fundamental with two
  fast-decaying harmonics, written to two channels a few cents apart. Five
  kits (dusty, room, heavy, machine, live) are the same voices with different
  numbers, including how far off the grid a hit is allowed to land.
- **Patterns** are 16th-grid strings, one per bar per instrument (`X` accent,
  `x` normal, `g` ghost, `o` open hat, `.` rest), with a swing amount that
  pushes the odd sixteenths late.
- **Determinism.** The noise is a seeded mulberry32, so the same record renders
  the same samples every time. That matters: the peaks drawn on a rack row are
  measured from the samples that play.
- **Speed.** Every oscillator reads a 4096-point sine table and every envelope
  is a multiply per sample rather than a `Math.exp`; the whole crate is about
  half a second of arithmetic instead of a second and a half. It is rendered
  one record at a time with a yield between them, so the page shows "3 of 6"
  rather than freezing.
- **Exact lengths.** Every file is exactly `lead-in + whole bars`, because
  `tileCandidate` assumes that a candidate's span from its downbeat is what
  fills the loop. Getting it wrong would have looked like a scheduler bug. It
  is asserted.
- **Levels.** Each record is normalised to a peak that leaves room for the
  others (0.34 for the bed, 0.46–0.52 for the breaks), every voice tapers over
  its last few milliseconds so a cut tail does not click, and the session's
  master is set to −3 dB on the first commit so three lanes at once do not
  clip. The master fader is in the strip; take it back if you want it louder.

**Into the engine.** `web/lib/demo/audio.ts` packs one record's channels into an
`AudioBuffer` and returns the same `DecodedSource` the library loader returns
after a fetch and a `decodeAudioData`. From there nothing can tell the
difference: the same decode cache with the same byte budget, the same pins and
eviction, the same `isReady`, the same `AudioBufferSourceNode`. The loader is
asynchronous on purpose, so the engine's "this lane is still waiting, join it
in progress when the samples land" path is exercised on every first audition
rather than being a path nobody walks.

The material is synthesised at 44.1 kHz whatever the browser's output rate is;
an `AudioBuffer` carries its own rate and the source node resamples it without
changing how long it lasts.

---

## 5. Exactly what is faked and what is real

| | |
|---|---|
| **Faked: the audio.** | Six synthesised records: a Rhodes bed in F minor at 92 BPM, and five drum breaks at 88.5, 95.5, 174, 103.5 and one with no measured tempo. |
| **Faked: the analysis values.** | Tempo, key, their confidences, the beat and downbeat grids, the tags, the loop scores and their components, and the embedding similarity are written by hand in `lib/demo/material.ts` to describe what was synthesised. They are what the analysis *would* have measured. |
| **Faked: the crate.** | Six `FileRow`s, five `StemRow`s and four `LoopRow`s, held in memory. No Supabase, no storage, no realtime. |
| **Faked: the conversation.** | Four written turns and one honest fallback line. There is no model. |
| **Real: the peaks.** | Measured from the synthesised samples, so the waveform you see is the waveform you hear. |
| **Real: the ranking.** | `buildMatches` and `compatibility` — the same pure functions `/api/compat` calls. The order of the five rows, the tie between rows 1 and 2, the half-time fold on row 3 and the refusal to score row 5 are all computed. |
| **Real: every row.** | `candidateFromMatch`, `candidateFromLoop`, `rackFromCompat`, `rackFromLoops` — the rack's own builders, unchanged. |
| **Real: the transport.** | `SessionEngine`, `planWindow`, `positionAt`, `DecodeCache`, `WebAudioBackend`. One clock, lanes as gain nodes, regions scheduled 250 ms ahead. |
| **Real: the rack.** | `RackPanel`, `CandidateRow`, `PeaksBar`, and `tileCandidate` laying a candidate under the loop from its downbeat. |
| **Real: the song.** | `SongSurface`, `TimelinePanel`, `RegionBlock`, `RegionInspector`, `LaneHeader`, `TimelineRuler`, and every edit in `arrangement.ts` through `planReconcile` and the undo stack. |
| **Real: the layout.** | `surfaceStack.ts` for the history, the shared `Divider`, the same split clamp, the same localStorage. |
| **Real: the command line.** | `parseSessionCommand` and `applySessionCommand`, both shared with the app. |
| **Real: the lineage.** | Every region on the timeline carries the record, the stem, the separator, the take and the reason it arrived with, and the bars it claims are recomputed on every edit. |

---

## 6. The bug this exercise found

**A loop whose length is not a round binary number missed its own wrap, over
and over, and every region on every lane lost the front of its downbeat when
it did.**

Four bars at 92 BPM is 10.434782608695652 s. The wrap walls are sums of that,
and some of those sums land a float hair *short* of a whole number of passes.
`positionAt` then returned `10.434782608695645` — the last seven femtoseconds
of the old pass instead of the first of the new one.

`segmentsInWindow` walks from one wrap to the next by adding `endS − position`,
so that hair advanced the cursor by 7e-15 of a second. The walk then marked
time until its 4096-iteration guard stopped it, and **the segment for the new
pass was never produced**. The lookahead therefore did not schedule anything
for that pass. The next 60 ms tick noticed, and every region started 6.5 ms
late with its head cut off (`joined: true`, offset advanced, duration short).

Measured on the demo's own session: in twelve passes of the loop it happened on
two of them. On a drum break, 6.5 ms off the front of the one is the attack of
the kick.

It was invisible to the existing tests because they use round loop lengths
(4.000 s), where the arithmetic is exact, and because the 1000-pass drift test
asserts `positionAt` at a time *inside* a pass rather than exactly on a wrap.

**The fix**, in `web/lib/session/time.ts`:

- `positionAt` snaps a remainder within `EPS` of the whole loop length to zero —
  a wrap that floating point landed a hair short of is a wrap that happened.
- `passAt` counts off the same remainder (`over % length`, which is exact)
  instead of `Math.floor(over / length)`, which can round *up* to a whole
  number the remainder says was not reached. Mixing the two was a second way
  for the position and the pass number to disagree about which side of a wrap
  a moment is on.
- `segmentsInWindow` now always advances its cursor by at least `EPS`, so no
  arrangement of floats can leave it marking time.

**The tests**, in `lib/session/time.test.ts` (four new, added; nothing
changed): 200 consecutive wraps of a 92 BPM four-bar loop read as the start of
the next pass; a window straddling each of those 200 wraps produces both
segments with the new one starting at the locator; the segments tile every
window exactly at the seam; and a six-pass window is walked in six segments.
Plus, at the engine level, `lib/demo/arc.test.ts` runs a hundred passes of the
demo's own bed and asserts every repeat is exactly one loop length after the
last — that test failed before the fix and passes after it.

**What to listen for in the browser**, because the ear is the real check: loop
four bars for two or three minutes with a break on it and listen for the kick
on the one losing its punch every minute or so. It should not happen now.

---

## 7. Shared files touched, and why

The brief said to touch shared components only where the prototype exposes a
real bug. One of these is that bug; the rest are seams the prototype could not
have been built without copying code, which the brief also forbade. Each is
listed here loudly, and each is covered by a test.

**7.1 `lib/session/time.ts` — the bug.** Section 6. Four new tests.

**7.2 `components/shell/applyCommand.ts` (new) and `Workspace.tsx`.** The
150-line switch that turns a parsed `SessionCommand` into a control movement
lived inside `Workspace`'s `Shell` component. The prototype needs exactly that
behaviour, and a copy of it would have been the parallel implementation the
brief rules out. It is now one exported pure-ish function over a small
environment (`session`, the rack, the panel, the zoom bus), and `Workspace`
calls it. The move was mechanical — same order, same wording, same refusals —
and it went from having no tests to having **24**
(`components/shell/applyCommand.test.tsx`), which assert that each verb moves
the control it names, that an unknown lane is refused rather than guessed, and
that bars are refused when the session has no measured tempo.

**7.3 `components/shell/Divider.tsx` (new) and `Workspace.tsx`.** The draggable
divider was a local function in `Workspace`. It is now its own file and both
shells import it. Behaviour unchanged; the maths it uses (`splitFromPointer`,
`clampSplit`) was already shared and already tested.

**7.4 `components/shell/SessionProvider.tsx` — an injected source loader.** The
provider hard-coded "sign a URL for the library file, fetch it, decode it". It
now takes an optional `loadSource` prop defaulting to exactly that
(`libraryLoader`, exported), and `/demo` passes a loader that synthesises. This
is the same dependency injection the engine already uses for its backend and
its ticker, and for the same stated reason: so the transport can be driven
without hardware or a network. The app's behaviour is unchanged — it does not
pass the prop.

**7.5 `lib/state/LibraryProvider.tsx` — do not throw when unconfigured.** The
provider called `createClient()` synchronously inside an effect, which throws
`EnvError` when `NEXT_PUBLIC_SUPABASE_URL` is missing and takes the whole tree
down with it. In the app this is latent: `app/(app)/layout.tsx` checks
`hasPublicEnv()` before mounting it. But the guard is in a different file, and
a store whose only failure mode is "nobody configured this" should say so
rather than crash. It now skips the realtime subscription and the refetch and
reports itself offline. **This one is not covered by a unit test** — the effect
only runs in a browser and vitest runs in node — but the prototype itself is
the exercise: it mounts the real provider with no environment at all, and the
server-render test proves the tree composes.

**7.6 `lib/supabase/middleware.ts` — `/demo` is a public path.** One entry
added to `PUBLIC_PREFIXES`. Without it, a *configured* deployment would bounce
a signed-out visitor from `/demo` to `/login`. Unconfigured deployments were
already fine (the middleware returns early with no keys).

**7.7 `vitest.config.ts` — `app/**/*.test.tsx` added to `include`.** The page
components next to the `/demo` route are `.tsx`, and the existing app pattern
only matched `.ts`. Additive: no file other than the new one matches it.

Nothing in `analysis/**`, `supabase/**`, `web/lib/billing/**`,
`web/lib/chat/**` or `web/app/api/**` was touched.

---

## 8. What is not done, and what is a rough edge

- **"Source" on a rack row leaves the prototype.** It is the real button and it
  pushes `/f/<file id>`, which is the app's record surface and needs the
  library. With no keys that route renders the setup notice, and leaving the
  page unmounts the session, so the audio stops. Browser Back returns. Fixing
  it properly means giving `CandidateRow` a way to say "there is nowhere to go
  from here", which is a change to a shared component for the prototype's
  convenience rather than for a bug, so it was left alone.
- **The chat is scripted.** Four turns and one fallback. Wiring the real
  `ChatPane` would need an API key and a server route, which the brief rules
  out.
- **Two racks, not a search.** "rack drums" and "hear what fits this" both
  resolve to the drums rack, and every ask is re-keyed to the rack it got so
  the panel's history holds one entry per object rather than one per phrasing.
- **The keyboard instrument (Surface 4) is not in it.** The pads exist in the
  app but are chop-driven, and there are no chops in the demo crate. The
  direction document expects the prototype to include it; it does not, and
  that is the biggest gap against the plan.
- **Nothing persists.** Reload and the session is empty again. That is true of
  the app as well (`OPEN_QUESTIONS 38` is still open).
- **No EQ, no processing.** Still the phase after the timeline.

---

## 9. What only a browser can confirm

I could not open one. The untestable surface was kept as thin as I could make
it — the synthesis, the crate, the ranking and the whole arc through the engine
are asserted in node — but these need eyes and ears, roughly in this order:

1. **Sound at all, on the first click.** The first numbered line creates the
   `AudioContext` inside a click handler and calls `resume()`. If the first
   press is silent and the second works, the gesture is not reaching
   `resume()` and that is the first thing to look at.
2. **The loop is seamless.** Loop the bed for two or three minutes. Listen for
   a click at the wrap and for the downbeat losing its front. Section 6 is why.
3. **The A/B.** Rows 1, 2, 3 in succession without stopping. Each should take
   over on the same bar and the bed should not flinch.
4. **The late decode.** The first press on a row starts a decode; the lane
   should come in mid-bar the moment it lands rather than waiting for the next
   pass. It is asserted at the engine level and never seen here.
5. **Row 5, the one with no tempo.** It should audibly re-trigger early. If it
   sounds fine, something is quietly fitting it and that would be a real
   problem.
6. **Clipping.** Bed plus a committed break plus an audition is three lanes.
   The master is set to −3 dB for that. If it still distorts, the synthesis
   peaks in `lib/demo/material.ts` are the knob.
7. **The timeline's pointer work.** Dragging a region across lanes, grabbing a
   2–8 px trim handle at a low zoom, scrubbing the ruler without hitting the
   locator band. All of this is listed as unverified in
   `docs/HANDOFF_timeline.md` section 10 and is still unverified.
8. **Below 1000 px.** The timeline handoff flagged this as untried. The
   prototype does something about it: under 900 px the chat and the panel stop
   sharing the width and take turns, the top bar's button says "Chat" instead
   of "Hide panel", the divider is not rendered and the crate rail is hidden.
   The chat stays mounted behind the panel so the transcript survives the
   toggle. **What is still untried is the timeline itself at those widths** —
   the lane headers are a fixed width and the `Lanes` view in the segmented
   control is the fallback. The timeline handoff's suggestion (switch to
   `Lanes` automatically under about 520 px) is still the right next move and
   is a change to `SongSurface`, which is shared.
9. **The synthesis time.** Half a second in node; it should be similar or
   better in a browser, split over six frames with a progress line. If it feels
   slow on a weak laptop the fix is fewer or shorter records, not a spinner.
10. **The sentences, in anger.** Type every line in section 3's list and check
    that the visible control moves and the echo matches.
11. **Memory.** The whole crate is about 12.5 MB of PCM and as much again once
    packed into `AudioBuffer`s, against a 384 MB budget, so the megabyte
    readout in the transport strip should sit near 20 MB and never grow. If it
    climbs, the cache is not evicting.

---

## 10. Decisions taken, and why

- **The prototype is a route, not a branch.** `/demo` lives beside the app and
  imports it. A mock of the workspace would have rotted in a week and would
  not have found the wrap bug.
- **The material is synthesised rather than checked in.** No binary in the
  repo, no download at build time, no licence question, and the peaks are
  measurably the peaks of what plays. The cost is half a second at load.
- **The crate's analysis is written by hand and said to be.** The alternative —
  running the real DSP in the browser — is a different project. Writing the
  numbers and being loud about it keeps principle 2 intact: the demo does not
  claim to have measured anything it did not.
- **One record has no tempo on purpose.** It is the only row that can show what
  "measure, don't guess" buys, and it is the row a producer learns the most
  from.
- **The session's grid comes from the record the session is built on**, never
  from a candidate, so opening a rack of loops inside an 88.5 BPM break cannot
  re-bar a 92 BPM song.
- **The audio is quiet by default.** −3 dB on the master and conservative peaks.
  A prototype that distorts makes the owner doubt the engine rather than the
  material.
- **The first click does three things** (adopts the tempo, sets the master,
  commits the lane) because it also has to be the gesture that starts the
  audio. A separate "enable sound" button would have been a fifth step and a
  worse first impression.

---

## 11. Files

```
web/app/demo/
  page.tsx          the route: metadata, and one client component
  DemoBoot.tsx      renders the crate one record at a time, with a progress line
  DemoShell.tsx     the workspace: crate, chat, divider, panel, transport
  DemoChat.tsx      the chat pane: transcript, the four steps, the command echo
  DemoCrate.tsx     the library rail: what is in the crate and what was measured
  script.ts         the four written turns and which sentence means which   (+ test)
  demo.test.tsx     the page and its parts, server-rendered        (test only, 16)
web/lib/demo/
  synth.ts          the audio, as pure arithmetic                      (+ test, 19)
  material.ts       the records, their analysis, the crate, the racks  (+ test, 20)
  audio.ts          the browser half: PCM -> AudioBuffer -> DecodedSource
  arc.test.ts       the whole arc through the real engine       (test only, 13)
web/components/shell/
  applyCommand.ts   a sentence moves a control (extracted from Workspace) (+ test, 24)
  Divider.tsx       the panel divider (extracted from Workspace)
  SessionProvider.tsx  an injected source loader (edited, additive)
  Workspace.tsx     now calls applyCommand and imports Divider (edited)
web/lib/session/
  time.ts           the wrap fix (edited)
  time.test.ts      four tests for it (added)
web/lib/state/LibraryProvider.tsx   degrades with no keys (edited)
web/lib/supabase/middleware.ts      /demo is public (edited)
web/vitest.config.ts                app component tests (edited)
docs/HANDOFF_prototype.md           this
```

## 12. What is tested

`pnpm test`: **127 files, 1251 tests, all passing** (1155 in 122 before this
work; 96 new). Nothing existing was changed, skipped or deleted.

| area | file | what is asserted |
|---|---|---|
| the audio | `lib/demo/synth.test.ts` (19) | bars and sixteenths agree with `lib/session/time`; equal temperament; the noise is reproducible; swing pushes only the odd sixteenths; a kick decays and a snare is brighter than it; an open hat rings longer; a break is exactly lead-in plus whole bars; it is silent before its downbeat; the backbeat lands where the grid says; normalising, edge fades, and peaks measured in range with the right point count |
| the crate | `lib/demo/material.test.ts` (20) | six analysed records with peaks measured from their own samples; whole bars after every lead-in; every record starts after its own silence; five drum stems with the separator that made them; the rack ranks five, ties at the top and lets timbre decide; the 174 BPM record counted half-time; "I can't tell" on the one with no tempo; provenance on every row; the loops rack ranked by score not by position; the bed tiling the loop exactly once; a candidate filling the loop with whole repeats; lineage surviving, and its bars changing on a head trim |
| the arc | `lib/demo/arc.test.ts` (13) | the real engine, hand-stepped: the bed starting on the record's downbeat; a hundred passes exactly one loop apart; no piece started twice on late ticks; a candidate landing under the bed without touching it; joining where the playhead already is; the A/B stopping one lane only; the next pass starting the new candidate from its head; every measured candidate lining up with the bed pass after pass; the unmeasured one re-triggering early; a decoding lane reported waiting then joining in progress; mute moving a gain node and stopping nothing |
| the page | `app/demo/demo.test.tsx` (16) | the whole workspace server-renders with no environment and no session; it opens as a chat with nothing on the panel; it says the audio is synthesised; the crate lists what was measured and says "no tempo" where nothing was; the four steps in order; every wired-up sentence parses as a command and every written turn does not; a command is never swallowed by the script |
| the command line | `components/shell/applyCommand.test.tsx` (24) | every verb moves the control it names; an unknown lane is refused by name; bars are refused with no tempo; the rack's audition, step, commit and refusals; the arrangement verbs through the same edit functions the drags use; deleting the selection clears it while naming a lane takes the lane |
| the wrap | `lib/session/time.test.ts` (+4) | section 6 |
