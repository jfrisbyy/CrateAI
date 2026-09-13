# HANDOFF_processing.md

Per-track corrective processing — the "Also in scope — corrective processing"
revision of `docs/PRODUCT_DIRECTION.md`, Surface 2's other half, and
OPEN_QUESTIONS 43.

It exists because of one session. A separated trumpet came back dull, there was
no way to open it up, and so the only verdict available was that all three
candidate layers were bad. A producer with an EQ would have fixed it in ten
seconds. Everything below is in service of that ten seconds staying inside the
product instead of turning into "bounce it and open Ableton".

The line, as it is drawn in code rather than in prose: a boost stops at
+12 dB, a high-pass stops at 400 Hz, a low-pass stops at 800 Hz, the master has
no makeup gain, and the model seam clamps to those rather than doing what it is
told (`web/lib/processing/types.ts`, and every clamp is tested). Past those
numbers a control has stopped answering *does this fit* and started being an
instrument.

## What is in, and what is not

**Built.**

| processor | where | what it is |
|---|---|---|
| Seven-band EQ per track | `eq.ts`, `chain.ts` | high-pass, low shelf, three peaks (low mid / mid / high mid), high shelf, low-pass. Every slot switchable, every number editable by hand, by sentence and by the AI. |
| Filters | the `hp` and `lp` slots | second-order, with their corners bounded to where a filter is still a correction. |
| Gain staging | `trimDb` | an input trim *before* the filters, separate from the lane's fader, so a boost does not run the chain hot and the fader is still free for the balance. |
| Tuning | `tune.ts` | cents, up to an octave either way. Honest about what it is: it resamples, so pitch and time move together the way a sampler does. |
| Master bus | `master.ts` | a level (the transport's existing master gain) and a gentle limiter — 8:1, 4 dB knee, 3 ms attack — with its own bypass and a live reduction readout taken off the node. |
| Bypass / A-B | `plan.ts`, `graph.ts` | a real dry path, crossfaded, plus hold-to-compare. |

**Refused, deliberately.**

- **Transient shaping.** This is the one thing in the brief's "in" list that is
  not here, so the reasoning matters. Web Audio has no envelope follower, so a
  real transient designer is either an `AudioWorklet` or a subgraph of
  waveshapers, lowpass followers and an audio-rate-modulated gain. Both are
  buildable; neither is *checkable* here. Its whole character is in two time
  constants and a modulation depth, and a wrong calibration does not fail a
  test, it just sounds bad — and an audio-rate modulation path that is not
  bounded correctly does not sound bad, it distorts. The brief's own
  instruction is that under-building is recoverable and I could not judge this
  one without ears, so it is not shipped rather than shipped blind. The place
  it goes is the end of the filter chain in `TrackProcessingStrip`, and the
  plan already has the shape a processor slots into. It should be built with
  someone listening.
- **Per-track compression.** Not in the direction document's list, and it is
  the first control that is production rather than correction: it changes how a
  part *behaves* rather than whether it fits. The master limiter is the one
  dynamics control, because "four lanes stacked on each other clip the output"
  is a fitting problem.
- **Makeup gain on the master.** Deliberately absent from the object, the plan
  and the node. The bus can only ever make the session quieter. Makeup is what
  turns a safety net into a loudness tool, and that is a mastering chain.
- **Saturation, stereo width, de-essing as a processor, reverb, delay,
  automation lanes, presets, plugin hosting, third-party formats.** None of
  these answer "does this fit". The de-esser is the closest call and it is
  covered: "sibilant" produces a narrow dip at 7 kHz, which is the same move
  with the curve visible.
- **Pitch-shifting with time held.** Tuning resamples. PRODUCT_DIRECTION is
  explicit that the phase vocoder is not good enough for the ratios this
  product asks for, so playback does not pretend to do what a render does. The
  interface says so, and says the percentage of time the tune costs.
- **Undo of processing through the session's undo stack.** The arrangement's
  undo is for the song. A chain has its own one-step "Undo that" on a proposal
  and "Reset" / "Take it off" for the rest. Putting EQ moves on the same stack
  would make undo mean "the last thing I touched" rather than "the last thing I
  changed about the song", which is the rule `HANDOFF_timeline.md` already set
  for mute and solo. Worth revisiting if producers reach for Cmd-Z after a drag
  on the curve.

## Files

```
web/lib/processing/               pure, except graph.ts
  types.ts        the chain as data, and the limits that are the scope line
  eq.ts           biquad coefficients, magnitude response, the curve, the axes  (+ test, 18)
  chain.ts        the state and every edit as a pure function                    (+ test, 26)
  tune.ts         cents <-> rate, and what tuning costs in time                  (+ test, 9)
  master.ts       one ceiling and one release -> a compressor's five numbers     (+ test, 7)
  plan.ts         a chain -> the exact value of every parameter on the graph     (+ test, 15)
  moves.ts        a proposal, and applying it with every clamp reported          (+ test, 15)
  complaints.ts   a producer's words -> moves, with no round trip                (+ test, 20)
  propose.ts      the model seam: the brief, the tool, the validation            (+ test, 20)
  persist.ts      the stored shape, read back forgivingly                        (+ test, 10)
  graph.ts        the ONLY Web Audio file here: nodes, ramps, the crossfade
  host.ts         how the controls reach the graph without the engine
  sentences.test.ts  the processing verbs on the command line            (test only, 18)
web/components/processing/
  ProcessingProvider.tsx  state, the bridge to the graph, the chat's verbs
  ProcessingDock.tsx      the strip above the transport; collapsed, one line
  ProcessingPanel.tsx     the surface, with no context in it                     (+ test, 16)
  EqCurve.tsx             the visible, editable curve                            (+ test, 11)
  BandRow.tsx             one band's numbers, editable, keyboard-reachable       (+ test, 6)
  MasterStrip.tsx         the bus                                                (+ test, 7)
supabase/migrations/
  20260913001400_track_processing.sql   written, NOT applied
```

## 1. Three layers, because the node layer must not decide anything

The same split the transport uses, for the same reason: there is no browser
here, so anything that decides has to be a pure function or it is unchecked.

**The decisions** (`eq.ts`, `chain.ts`, `tune.ts`, `master.ts`). Filter design,
gain arithmetic, cents to rates, limiter settings, and every clamp.

**The plan** (`plan.ts`). A chain plus a sample rate becomes one object holding
the exact target value of every parameter on the graph: the trim's linear gain,
the dry and wet gains, and for each of the seven slots its type, frequency, Q,
gain and the neutral frequency it should ramp in from. Everything a node layer
could have had an opinion about is settled here and asserted in node.

**The nodes** (`graph.ts`, 241 lines). Two small classes that walk a plan and
ramp parameters. No arithmetic, no thresholds, no conditionals about what a
control means.

The per-track graph:

```
pieces -> input ----------------------------> dry ------\
             \                                           +--> output -> lane fader
              -> trim -> hp ls lo mid hi hs lp -> wet ---/
```

and the bus is the same shape around a `DynamicsCompressorNode`, between the
transport's existing master gain and the destination.

### The curve is the filter, not a picture of one

`eq.ts` implements the formulas the Web Audio specification prescribes for
`BiquadFilterNode`, at the context's real sample rate, and the drawn line is
`20·log10|H(e^jω)|` summed across the enabled bands. So the line on screen is
the response of the filters that are actually running. The tests assert the
claims that make that worth anything: a peaking band gives exactly its stated
gain at its own frequency, a Butterworth high-pass is 3.01 dB down at its
corner, a low shelf reaches its full gain at DC and nothing at Nyquist, a boost
and a cut of the same size at the same spot cancel to zero, and the same filter
reads differently at 44.1 kHz and 48 kHz — as it does in the browser.

Two details the specification fixes and this therefore fixes: **the shelves
ignore Q** (the spec computes them with S = 1), so the panel says "shelf"
instead of offering a control that would move the drawing and not the sound;
and **a peaking or shelving filter at 0 dB is exactly unity** (b == a), which is
what lets a switched-off band sit in the graph costing the signal nothing.

## 2. How a parameter change reaches the graph without a click

**Nothing is ever re-wired.** Each lane's strip is built once, complete, the
first time the lane exists. Switching a band on, bypassing the chain, dragging
a handle and a model's proposal all change parameters on nodes that were
already connected. There is no `connect`/`disconnect` after construction and
therefore no dropped buffer and no discontinuity at a splice.

**Every value is a ramp**, 15 ms for parameters and 8 ms for the bypass
crossfade. Gains and Qs ramp linearly; **frequencies ramp exponentially**,
because an octave is an octave wherever it is and a linear frequency sweep
sounds wrong. Every ramp is bounded by the `AudioParam`'s own `minValue` and
`maxValue` before it is scheduled, so a frequency can never be scheduled past
Nyquist.

**A switched-off band settles to exact unity, and comes in from the edge.** A
disabled peak or shelf just ramps its gain to zero — unity, exactly. A disabled
pass filter is the awkward case: parking a high-pass at 10 Hz still takes a
fraction of a dB off the bottom, and parking a low-pass at Nyquist takes nearly
2 dB off the top octave, which on the 8–20 kHz air the direction document cares
about is precisely the loss we are trying not to cause. So a disabled pass slot
ramps its corner out to the harmless end and *then* takes the `peaking` type,
which is a mathematical pass-through; enabling reverses it — the type is taken
while the corner is still at the harmless end, and the corner is then ramped
in. That is the one piece of state in the node layer (a timer per slot, guarded
against the band being switched back on in the meantime), and it is mechanical:
the plan says what the neutral shape is.

**The tune is the exception, and it is deliberate.** It is not a filter — it is
the rate the samples are read at — so it lives on the source nodes. Changing it
ramps `playbackRate` on every piece already in flight on that lane and is
picked up by `start()` for everything scheduled after. **No region is ever
re-scheduled for a processing change**, and the engine is never told about one.

## 3. Bypass, and the A/B

Bypass is a **real dry path**: the signal reaches the lane's fader without
having passed through a filter, and engaging the chain is an 8 ms equal-gain
crossfade between that and the processed path. It is not a chain set flat,
which matters because a producer A/Bing wants to hear what they started with.

Three ways to reach it, all the same control:

- **On / Bypassed**, a toggle with `aria-pressed`, which is also what the
  curve dims to show.
- **Hold to compare** — press and hold to hear the other one, let go and it is
  back exactly as you found it (including when you were already bypassed, which
  is the case a naive implementation gets wrong). Pointer and keyboard, and it
  releases on blur so a hold cannot get stuck.
- **A sentence**: `a/b the drums`, `bypass the horns`, `engage the drums`.

The trim and every band are inside the bypass; **the tune is not**. A/Bing a
curve must not also retune the lane underneath, or the comparison is between
two different things.

## 4. The AI seam, and what it is handed

The requirement is that the AI drives the tools and the tools stay visible.
That is a shape, not a feature: **whatever decides produces a `ProcessingProposal`
and nothing else**, and that proposal is applied through the same `setBand` /
`setTrim` / `setTune` a drag runs. There is no path by which a sentence or a
model changes a chain without moving a control the producer can see and correct.

There are two things that decide, and one place they both land.

### The narrow half: `complaints.ts`

A tested vocabulary — muddy, boomy, rumbly, boxy, honky, harsh, sibilant, dull,
thin, too loud, too quiet, brighter, warmer, fuller, darker, tighter — mapped
to real moves with real frequencies and the reason for each. It answers with no
round trip, which is exactly how the rest of the command line already behaves
("parse first, model second"). It reads "a bit" and "way too" and scales the
move. It returns **null** when the words name no problem it knows, and null is
the important return: that is what sends the sentence to the model instead of
guessing.

`"clean it up"` with nothing named is the owner's own sentence, so it has to do
something. It produces the three moves that are almost always right after
separation (the rumble a separator leaves under the part, the low-mid build-up,
and a shelf for the air it took), at a confidence that lands in the
`"roughly"` band, with a note saying plainly that it is the shape that is
usually right rather than a diagnosis, and offering the words that would aim it.

### The model half: `propose.ts`

**The payload.** `ProcessingBrief` is small on purpose — a payload a model can
answer well is one where every field is the producer's own words, a measurement
with its method, or the current position of a control it is about to move:

- the complaint, verbatim and unedited;
- the track: name, the provenance line the lane already shows, the stem, **which
  separator made it**, and the resampling already in play;
- **the source's measured bandwidth, with its method** (`Spectral.bandwidth`
  from the report), or "not measured — do not assume there is air to lift";
- the session tempo;
- the chain as it reads now, in one line;
- the limits, stated rather than discovered.

`briefLines()` renders it as flat lines with units on every number.

**The answer.** `PROPOSE_PROCESSING_TOOL` is a strict tool definition shaped
exactly like the entries in `lib/chat/tools.ts`, so wiring it is one line there
and one handler case. Its fields *are* the controls — `band`, `frequency_hz`,
`gain_db`, `q`, `trim_db`, `tune_cents` — and every move requires a `why` whose
description says it must be about the move and never a claim about the audio
that was not measured and given to it. There is nowhere in the schema to return
a fact, which is how principle 2 is enforced structurally rather than by
instruction.

**What happens to the answer.** `parseProposal` validates with zod and is
unforgiving: a malformed answer becomes a refusal a producer can read, never a
half-applied chain. A move naming no band or carrying no numbers is skipped
with a note. Then `applyProposal` clamps — and **every clamp is reported**:
"asked for +24 dB; this goes to +12 dB". And the bandwidth rule: a boost above
the measured ceiling is pulled down to the ceiling with "the record stops at
13.5 kHz, so a lift at 16 kHz would be lifting nothing that is there". A cut up
there is left alone, because taking something out is always allowed.

**It never calls an API.** `requestProposal(brief, ask)` takes the call as an
argument. The tests drive it with a fake that answers well, badly, out of
range, with an unknown band, and by throwing.

**What is left to wire (outside this seam):** `PROPOSE_PROCESSING_TOOL` into
`CHAT_TOOLS`, and a handler that builds the brief and hands the validated
proposal back to the client. `ProcessingContext.busy` is the flag that becomes
real when it is. Until that exists, anything conversational that the narrow
vocabulary does not recognise reaches the model, and the model has no tool to
answer with. **That is the single biggest gap in this work.**

**One exception was made for the owner's own sentence.** "This trumpet sounds
awful, clean it up" has two clauses in it, and the rest of this parser refuses
two clauses on principle — which would have meant the headline example of the
whole feature did nothing at all until the chat tool is wired. So a *trailing*
"clean it up" / "sort it out" is taken as an instruction however the sentence
starts, but only when there is no question word and no conjunction anywhere in
it. "Why does this sound bad, clean it up" and "tell me what is wrong and clean
it up" are still questions and still reach the model whole; both are asserted.

### Visible afterwards

A proposal leaves: the curve marked at every band it moved, each band's row
carrying the reason it gave in its own words, a banner with the summary, its
confidence dot (hedged through `lib/report/hedge.ts` like everything else),
each move in the units on the controls, every note about what it refused, and
one press to put it back. And it engages the chain, because a chain nobody can
hear is not an answer.

## 5. Everything the mouse can do, a sentence can do

| sentence | control |
|---|---|
| `show the eq on the horns`, `open the processing` | the dock, on that lane |
| `clean up the trumpet`, `sort out the drums`, `fix it` | the ask box |
| `this trumpet sounds awful, clean it up` | the same (see section 4) |
| `make the horns less muddy`, `make it brighter`, `the drums are too boomy` | the same |
| `cut 300 on the drums`, `boost 4k on the horns`, `dip 1.2khz by 3db on the bass` | a band |
| `cut the low mids on the horns`, `boost the highs` | a band, by region |
| `high-pass the bass at 80`, `low pass the horns at 9k` | the pass slots |
| `tune the horns up 20 cents`, `tune the trumpet down 1 semitone` | the tune |
| `a/b the drums`, `bypass the horns`, `engage the drums` | the A/B |
| `reset the eq on the drums`, `clear the processing` | Reset |
| `limit the master`, `turn the limiter off` | the bus |

With no lane named, a processing verb means the lane the producer is on — the
one open in the dock, or the lane of the region selected on the timeline. The
parser is as narrow as the existing one and there is a test that runs twelve
real conversational sentences ("why do these drums sound muddy", "what would
you eq out of this", "can you clean up the trumpet and tell me what you did",
"explain the eq you put on the horns") and asserts every one is left alone —
plus the pre-existing list in `commands.test.ts`, which still passes untouched.
`cut the drums to 4 bars` is still an arrangement trim: the EQ branch falls
through cleanly when what is being cut is not a frequency.

## 6. The persistence shape

`supabase/migrations/20260913001400_track_processing.sql`, **written and not
applied**. Two `jsonb` columns on tables the arrangement migration already
defines, guarded with `alter table if exists` so it is a no-op against a
database where `20260913001000` has not been run:

- `song_tracks.processing` — the chain. Processing is a property of the track
  and a reload that drops a 3 dB shelf turns the producer's decision into
  something they have to remember and redo.
- `song_sessions.master_processing` — the bus. There is no makeup gain in that
  object because there is none on the bus.

A blob rather than columns, unlike the arrangement's regions, and the reason is
in the migration: nothing queries *inside* a chain. "What is in bar 17" is a
question about regions and needs columns; "what EQ is on the horns" is only ever
asked about one lane already in hand. A slot's filter shape is not stored —
its id decides it — and the drawn curve is computed at read time from the same
arithmetic the audio uses, so there is no stored response to go stale.

`persist.ts` reads forgivingly in one direction only: missing fields come from
the default chain, numbers written by a future version with wider limits are
clamped to what the controls can actually do, an unknown band id is ignored, a
blob claiming `hp` is a peaking filter is read back as the high-pass it is, and
a blob that is not an object loads as *no processing* rather than throwing. A
song that will not open because of an EQ is worse than one that opens flat.
Nothing reads or writes those columns yet.

## 7. Exactly what changed in `web/lib/session/`

Two files. `types.ts`, `engine.ts`, `schedule.ts`, `time.ts`, `mix.ts`,
`rack.ts`, `arrangement.ts`, `reconcile.ts`, `lineage.ts`, `snap.ts`,
`viewport.ts`, `history.ts`, `fakes.ts` and **every existing test file** are
untouched.

**`webAudio.ts`** (+100 / −24). The only file that had to change for the audio,
and only to put the chain in the graph:

- `trackNodes: Map<string, GainNode>` became `lanes: Map<string, Lane>`, where a
  `Lane` is `{ strip, fader }`. `ensureTrack` now returns `void` (it returned a
  `GainNode` before; `TransportBackend` always declared `void`) and a private
  `lane()` does the building. Pieces connect to `strip.input`; `strip.output`
  connects to the fader; the fader connects to the master. `setTrackGain` ramps
  the fader, unchanged in behaviour.
- The master gain now feeds a `MasterProcessingStrip` which feeds the
  destination. `setMasterGain` is unchanged.
- `start()` multiplies the lane's tune into the playback rate and keeps the
  region's own `baseRate` on the live entry so a retune can be a ramp. The
  clamp `duration = min(duration, (buffer.duration - offset) / rate)` now uses
  the effective rate, so a tuned-up lane cannot be asked for samples past the
  end of its buffer.
- Four new methods implementing `ProcessingHost` (`sampleRate`,
  `setTrackProcessing`, `setMasterProcessing`, `limiterReduction`), plus
  `registerProcessingHost(this)` in the constructor and `releaseProcessingHost`
  in `dispose()`.

**`commands.ts`** (+147, additive). Seven new members on the `SessionCommand`
union (`processing`, `processing-bypass`, `processing-reset`, `fix`, `eq`,
`tune`, `limiter`), one parse block placed between the mix verbs and the rack
verbs, two helpers (`hzFrom`, `phraseFor`), a `REGION_WORDS` table, the matching
`describeCommand` cases, and one sentence added to the `SELECTION` doc comment.
Nothing existing was edited. It imports two types from `@/lib/processing/types`;
`lib/processing` imports nothing from `lib/session`, so there is no cycle.

**`engine.ts` was not touched, and that was the point.** A filter changes
nothing about when a piece starts, so the scheduler has no reason to know about
one. The backend registers itself as a processing host
(`lib/processing/host.ts`) and the provider pushes state at whichever host is
current — including when the host appears later, since the engine is built
lazily on the first sound.

Outside `lib/session`: **`components/shell/Workspace.tsx`**, three edits — two
imports, `<ProcessingProvider>` wrapped around `<Shell>` inside
`<SessionProvider>`, and one `<ProcessingDock />` above the transport strip. Nothing else in `components/shell`
was edited, and `components/timeline`, `components/rack`, `lib/chat`,
`web/app/api` and `analysis/` are untouched.

## 8. What is tested

`pnpm test`: **136 files, 1354 tests, all passing** (122 files / 1155 tests
before this work; 199 new across 14 new files). Nothing existing was changed,
skipped or deleted.

| area | file | what is asserted |
|---|---|---|
| the filters | `lib/processing/eq.test.ts` (18) | a peak gives exactly its stated gain at its frequency; Q widens it and does not change its peak; a Butterworth pass filter is 3.01 dB down at its corner and 20 dB down an octave away; a shelf reaches its gain at DC and unity at Nyquist; 0 dB is exactly unity (b == a); a boost and a cut cancel; the curve is log-spaced and its deepest point is where the band is; 44.1 kHz and 48 kHz differ near the top; the axes round-trip |
| the chain | `lib/processing/chain.test.ts` (26) | seven slots, all off, each the shape its id says; bypassed to start; boosts capped at +12 and cuts at −24; a high-pass refused past 400 Hz and a low-pass under 800; pass filters given no gain; an edit that changes nothing returns the same object; one slot moved leaves the other six identical; a band at 0 dB counts as doing nothing; one lane's chain never reaches another; a removed chain is gone; the limiter takes the bus out of bypass; every line it says |
| the plan | `lib/processing/plan.test.ts` (15) | bypass is dry 1 / wet 0 and takes the trim with it but **not** the tune; a disabled band is asked for exactly 0 dB; the high-pass parks at 10 Hz and the low-pass at Nyquist; the neutral shape is named; the master is out of circuit until the limiter is on; identical plans compare equal |
| tuning | `lib/processing/tune.test.ts` (9) | an octave is a doubling, a semitone is the twelfth root of two, round trips, the octave cap, a region's own rate multiplied rather than replaced, and how much time a tune costs |
| the bus | `lib/processing/master.test.ts` (7) | the ceiling is the threshold; 8:1 and not a brick wall; 3 ms attack; clamps; **no makeup gain anywhere in the object**; no loudness claim in what it says |
| a proposal | `lib/processing/moves.test.ts` (15) | it moves the controls a drag moves; every clamp is reported in words; an unknown band is skipped and named; **a boost above the measured bandwidth is pulled to the ceiling and a cut is not**; nothing measured means nothing assumed; "nothing changed" is reported rather than faked; the hedge word comes from the confidence band |
| the vocabulary | `lib/processing/complaints.test.ts` (20) | muddy lands at 200–320 Hz and clears the sub; **dull opens the top rather than turning it up**; sibilance gets a dip more than twice as narrow as mud's; rumble high-passes rather than dipping; level words move the trim, not a band; "a bit" and "way too" scale the move; a sentence naming no problem returns null; "clean it up" does something, hedges itself into "roughly", says it is not a diagnosis, and **does not put air back on a record that has none** |
| the model seam | `lib/processing/propose.test.ts` (20) | the brief carries the complaint verbatim, the separator, the resampling, and the bandwidth with its method — or says it was not measured; the tool is strict and its fields are the controls; the limits are told rather than discovered; a good answer applies; nonsense, a confidence out of range and a move with no numbers are all refused rather than half-applied; an over-eager answer is clamped and reported; a lift above the bandwidth is pulled down; a throwing call becomes one line; no network is touched |
| persistence | `lib/processing/persist.test.ts` (10) | exact round trip; a version; a slot's shape not stored; missing fields filled; numbers from a wider future clamped; unknown bands ignored; a non-object loads as no processing; a master that is bypassed and limiting at once is read back honestly |
| the sentences | `lib/processing/sentences.test.ts` (19) | every verb in the table above; the owner's two-clause sentence caught and the two question-shaped ones next to it refused; twelve conversational sentences left alone; `cut the drums to 4 bars` still an arrangement trim; a fader move still a fader move; a line for every command; a spoken cut and a complaint landing on the same band |
| the curve | `components/processing/EqCurve.test.tsx` (11) | flat down the middle when nothing is on; the dip is where the band is and as deep as it says; a high-pass rolls the bottom off; the drawing changes with the sample rate; a handle per band that is doing something and none for the rest; the handle sits where the curve says; a pass filter's handle stays on the zero line; the bands a proposal moved are marked |
| the surface | `components/processing/ProcessingPanel.test.tsx` (16) | all seven slots on screen with editable numbers; no gain control on a pass filter and no Q on a shelf, with the reason; bypass says which way it is and that it is the dry signal; trim and tune say what they are, and the tune says how much time it costs; a proposal's moves, confidence, per-band reason, refusals and undo; the ask box and its vocabulary; "Take it off" and that the audio was never touched |
| the rows and the bus | `components/processing/{BandRow,MasterStrip}.test.tsx` (13) | bounds on every input; the limiter's settings said exactly with no loudness claim; the reduction readout; a bypassed limiter keeping its settings |

`pnpm typecheck`, `pnpm lint` and `pnpm build` are clean.

## 9. What only real ears can judge

There is no browser here and no signed-in session. In rough order of how much
they matter:

1. **Whether the default curves are right.** This is the big one and no test
   touches it. Is 250 Hz the right place for "muddy" on a separated horn? Is
   −4 dB at Q 1.2 the right size, or does it want to be wider and shallower? Is
   the "dull" answer — a 3.5 dB shelf at 8 kHz with 2 dB of presence under it —
   what actually rescues the trumpet from the second session, or does it just
   make the separation artefacts louder? Every number in `complaints.ts` is a
   producer's first guess written down; they are in one table, with one
   `scale` argument, so they are cheap to move once someone has listened.
   **Do this with the actual trumpet.**
2. **Whether the limiter is gentle enough to leave on.** 8:1 with a 4 dB knee
   and a 3 ms attack is a judgement. Stack four lanes, turn it on, and listen
   for whether the session starts to sound limited before it stops clipping.
3. **The bypass crossfade.** 8 ms between two highly correlated paths. The
   maths says it is short enough not to comb audibly; the ear decides. A/B
   rapidly while a loop plays and listen for a swish on the swap. If it is
   there, the fix is a shorter fade or a single-path bypass, and the trade is
   written in `graph.ts`.
4. **Whether a parameter ramp is really click-free.** 15 ms is standard, and
   frequencies ramp exponentially so the sweep is musical. Drag a high-pass
   corner fast from 20 Hz to 400 Hz while a break is playing and listen for
   zipper noise; do the same with a 12 dB peak.
5. **The disabled-pass-filter dance.** Switching a high-pass off ramps its
   corner down and then swaps the node's type ~35 ms later. The type swap is a
   coefficient change at a frequency where the filter is nearly unity, so it
   should be inaudible — confirm, on a bass-heavy lane, that switching a
   high-pass off does not tick.
6. **The tune, and whether the honesty is enough.** Tune a lane up a semitone
   and let a four-bar region play out: the lane eats its source about 5.6 %
   faster, so a long region will run out before its slot ends and go silent at
   the tail. The panel says the percentage; whether that is enough warning, or
   whether the region should be visually shortened on the timeline, is a
   decision for someone who has hit it.
7. **CPU with a dozen lanes.** Each lane carries seven biquads plus three gains
   whether or not it is being used. That should be nothing, but it has never
   run. If it is not nothing, the fix is to build the strip lazily on the first
   chain and accept one splice.
8. **Whether the dock is the right place.** It is a strip above the transport
   rather than a panel surface, on the argument that an EQ is a control you use
   *while* listening to an object rather than an object itself. It has not been
   tried below about 1000 px, and the curve is 150 px tall, which may be too
   short to aim at.
9. **The reduction readout.** It polls `DynamicsCompressorNode.reduction` at
   4 Hz. Confirm it moves, and that 4 Hz reads as a meter rather than a
   flicker.

## 10. What is not done

- **The chat cannot call it.** `PROPOSE_PROCESSING_TOOL` is written, validated
  and tested against a fake, and is not in `CHAT_TOOLS`, because
  `web/lib/chat/**` and `web/app/api/**` are outside this seam. Until it is,
  the conversational complaints — the ones the command line correctly refuses
  to swallow — reach the model and it has nothing to answer with. One tool
  entry and one handler.
- **Nothing is persisted.** The migration is written and not applied, and
  nothing reads or writes those columns.
- **Transient shaping** (section "What is in, and what is not").
- **No per-band solo** ("listen to just this dip"), which is the next thing a
  producer will ask for after the A/B and is a genuinely useful diagnostic.
- **No spectrum behind the curve.** A live analyser under the response is what
  turns "I think it is muddy" into "it is muddy *there*", and it fits the
  product's measure-don't-guess rule better than the vocabulary does. It needs
  an `AnalyserNode` on the lane and a frame loop; it is not here because it is
  a new decision about what to show and I could not judge it without seeing it.
- **Processing is not in the region's lineage.** A region knows it is bars 9–16
  of a record pitched +62 cents; it does not yet know the lane it is on has a
  4 dB dip at 250 Hz. For the breakdown to stay honest once a chain is on a
  lane, `lineageParts` should probably pick it up — but lineage is per region
  and processing is per track, so that is a real design decision rather than a
  field to add, and `lib/session/lineage.ts` is another seam's file.
- **No export.** Nothing renders a processed lane to a file. When it does, the
  chain is the thing that has to be applied offline, and `plan.ts` is what an
  offline renderer should read so the render and the playback cannot disagree.
