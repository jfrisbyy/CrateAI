# HANDOFF_keyboard.md

The keyboard as the instrument — Surface 4 of `docs/PRODUCT_DIRECTION.md`,
OPEN_QUESTIONS 44 and 45, built on the Phase 3 pads and on the session
transport's clock (`docs/HANDOFF_session_transport.md`).

What a producer can do now that they could not before: **hold a key and hear
only what they are holding**, play one stab up and down the keys as an
instrument, spread a long record over eight, sixteen, twenty-four, thirty-two
or forty keys, have the cuts proposed with the measurement behind each one and
drag them before anything is chopped, have the kit laid out by measured hit
class instead of file order, tighten a take toward the grid *by an amount*
without losing the take they played, hear variations that are strictly their
own hits rearranged, and put the take on a track in the session, on the next
bar line of the session's own clock.

## Files

```
web/lib/pads/                    no React, no Web Audio except webAudioPads.ts
  layouts.ts     the presets and the one mapping function                  (+ test)
  keymap.ts      Phase 3's helpers, now reading the `16` preset            (+ test)
  kit.ts         a kit: layout, trigger, play mode, root, pad order        (+ test)
  note.ts        2 ** (semitones / 12), the root, the note names           (+ test)
  held.ts        which keys are down; OS repeat and lost focus             (+ test)
  backend.ts     PadBackend: the browser half, behind one interface
  engine.ts      PadEngine: note on, note off, the fades, the voices       (+ test)
  webAudioPads.ts  the only file in lib/pads that touches Web Audio
  fakes.ts       FakePadBackend and a clock a test steps by hand
  instrument.ts  key/pointer in, voice out; repeat, release, note mode     (+ test)
  latency.ts     key-to-sound, measured, with a bounded rolling window     (+ test)
  slices.ts      AI 1: where the cuts go, with reasons and corrections     (+ test)
  kitOrder.ts    AI 2: which key gets what, from the measured pattern      (+ test)
  cleanup.ts     AI 3: tighten by an amount, collapse flams, flag          (+ test)
  patterns.ts    AI 4: rearrangements only, plus the model seam            (+ test)
  takeToSession.ts  a take as SessionTrack + SessionRegion[]               (+ test)
  commands.ts    sentence -> KeyboardCommand, and the bus                  (+ test)
  recorder.ts    (edited) gate note-offs, note-mode semitones
  recording.ts   (edited) TakeHit/Take: length_s and semitones
  bindings.ts    (edited) any pad count, and applyOrder
  grid.ts, click.ts  untouched
web/lib/keys/
  commands.ts    (edited) layout resolver, pad repeat + timestamp, keyup   (+ test)
web/components/keyboard/                                     new
  KeyboardPanel.tsx      the instrument: controls, pads, recorder, the four AI roles
  KitControls.tsx        layout, trigger, play, root, polyphony, latency
  SlicePanel.tsx         proposed cuts with their reasons, draggable
  KitOrderPanel.tsx      which key gets what, and the drag that corrects it
  TakePanel.tsx          cleanup, variations, and "keep it in the session"
  KeyboardCommandLine.tsx  the sentence half, on the same bus the chat would use
  useKit.ts              the kit as React state
  KeyboardGrid.test.tsx  the grid and the controls, rendered                (+ test)
web/components/chops/
  usePads.ts     (rewritten) engine + recorder + instrument + key listeners
  PadGrid.tsx    (rewritten) layout-aware, gate-aware, note-aware
  RecordPanel.tsx  (edited) length, click and save are controlled from above
web/components/surface/
  ChopsTab.tsx   (edited, outside this seam — see "One file outside the seam")
```

Nothing else was touched. `web/lib/session/**` was read and not changed;
`analysis/**`, `supabase/**`, `web/app/api/**`, `web/lib/billing/**`,
`web/lib/chat/**`, `web/components/timeline/**` and `web/app/demo/**` were not
opened for writing at all.

## 1. The engine: one-shot, gate, and note mode

`PadEngine` gained `noteOn`, `noteOff` and `releaseAll`, and lost its Web Audio
dependency to `PadBackend` (`backend.ts`), implemented once for the browser
(`webAudioPads.ts`) and once for tests (`fakes.ts`). The split is the same one
the session transport uses and for the same reason: there is no browser in this
repo, and the timing decisions are the part worth asserting. Phase 3's
`trigger(pad, fileId, velocity)` still exists and still returns the audio-clock
time, implemented as `noteOn(..., { trigger: "one-shot" })`.

| | what it does |
|---|---|
| `one-shot` | the whole slice plays out; `noteOff` returns 0 and cuts nothing |
| `gate` | `noteOff` fades the pad's voices to silence over **`PAD_RELEASE_S` = 2 ms** and stops them |

The release is a ramp, never a hard stop. Cutting a waveform at an arbitrary
sample is a click, and gate mode is exactly the mode where a producer hears
every one of them — the whole point of it is tapping between two keys to hunt a
chop. The attack keeps Phase 3's 3 ms fade for the same reason at the other
end, and a one-shot still fades out over its last 3 ms.

**Note mode** is the sampler's implementation and nothing cleverer:
`playbackRate = 2 ** (semitones / 12)` on the source node, so pitch and length
move together. `semitonesForPad(pad, rootPad)` counts one semitone per key and
`defaultRootPad(count)` puts the root in the middle of the layout (pad 8 of 16,
16 of 32, 20 of 40), so there is room either side. Transposition is clamped to
two octaves: past that a slice is not a sound any more. In note mode every key
plays the *same* slice — the one on `notePad ?? rootPad` — which is decided in
`PadInstrument.fileFor`, not in the grid, so the pads, the recorder and the
session all agree about what sounded.

A voice's transposition rides through everything downstream: the recorder
stamps `semitones` on the hit, and `takeToSession` turns it back into the
region's `rate`, which is the same field the rack uses when it resamples a
break to fit. A melody played on the keys arrives on the timeline as a melody.

## 2. Key repeat, and every way a key-up can go missing

Both live in `lib/pads/held.ts` and `lib/pads/instrument.ts`, both are pure, and
both are asserted in node.

- **OS repeat.** A held key fires `keydown` again and again. `HeldPads.press`
  returns `"repeat"` for any pad already down, **whether or not the browser set
  `event.repeat`** — belt and braces, because `repeat` is not reliable
  everywhere and a missed one machine-guns the slice. `PadDetail` now carries
  `repeat` so the flag is available as well; the set is what actually decides.
  A repeat for a pad we never saw go down (focus arrived mid-hold) is taken as
  the start, so the key is not dead until it is released.
- **`keyup`.** The shell only ever listened for `keydown`, so `lib/keys/commands.ts`
  gained `handleKeyup` (emitting `crateai:pad-up`) and `usePads` attaches the
  window listener itself. Nothing in the shell had to change. If the shell ever
  adds one too, it is harmless: releasing a pad that is not held is a no-op.
- **`blur`** (alt-tab, another window) releases everything held.
- **`visibilitychange` to hidden** (another tab) releases everything held.
- **`focusin` on an input, textarea, select or contenteditable** releases
  everything held. This is the one that is easy to miss: clicking into the chat
  box does *not* blur the window, and the typing guard swallows the key-up when
  it arrives, so without this a note hangs the moment a producer holds a key and
  clicks into a text box.
- **A layout, trigger or play-mode change** releases everything held, because
  the pad numbering under the producer's fingers just changed.
- **Unmount** releases everything held.

`PadEngine.releaseAll()` uses the same 2 ms fade as a key-up, so none of these
is a click either. "All off" in the controls and "all off" in the command line
both call it.

## 3. The layouts, and the mapping function

`lib/pads/layouts.ts` is the only key-to-pad mapping in the product. The
on-screen grid, the engine, the recorder, the key handler and the chat all read
`padForKeyIn(layout, key)` / `keyForPadIn(layout, pad)`, so they cannot disagree
about what `R` means. `keymap.ts` — Phase 3's `PAD_KEYS`, `padForKey`,
`keyForPad` — is now a thin read of the `16` preset, and its existing test still
passes unchanged, which is the proof that the default mapping did not move.

| preset | keys | drawn as | for |
|---|---|---|---|
| 8 | `1`–`8` | one row of 8 | a break in eighths |
| 16 | `1`–`8`, `Q`–`I` | 4 x 4 | the default; exactly what Phase 3 shipped |
| 24 | + `A`–`K` | 3 x 8 | a longer phrase |
| 32 | + `Z`–`,` | 4 x 8 | the deepest chopping, two-handed |
| full | all four rows, ten each | 4 x 10 | forty slices |

`rowsOf(layout)` draws the rows the keys actually sit in, so the picture and the
hand match. A layout change keeps the slices it can (the first N keys keep
theirs) and puts the root back in the middle unless the producer had moved it
somewhere that still exists.

**Which key gets what** is `PadKit.order` — `order[i]` is the slice index pad
`i + 1` plays — applied by `applyOrder(bindings, order)`. `bindPads` now takes a
pad count. The order is always computed against the *file-order* bindings
(`baseBindings`), never against the already-ordered ones, so ordering twice
cannot compose into something nobody asked for.

### Shortcut collisions

`handleKeydown` still refuses every `Ctrl`, `Cmd` and `Alt` combination before
anything else, so Cmd-R, Cmd-T, Ctrl-C and the rest reach the browser untouched
— there is a test that walks a list of them and asserts both `handleKeydown` and
`handleKeyup` return false. Single-key in-app shortcuts are the real collision:
the 24-key layout claims `D` (set the downbeat), 32 claims `D` and `,`, and the
full keyboard claims `D`, `L`, `,` and `.`. The instrument registers its layout
with `setPadKeyResolver` **while it is mounted**, pad keys are matched before
the letter commands, and `KitControls` says in words which shortcuts the chosen
layout has taken over. With no instrument on screen the resolver is null and
every shortcut behaves exactly as it did.

### The ceiling, said out loud

`MAX_SIMULTANEOUS_KEYS = 3` and `POLYPHONY_NOTE` live in `kit.ts` and are
printed under the controls at all times: *"A laptop keyboard registers about
three keys at once, whatever the layout. More keys is more slices, not more
polyphony — chords need a MIDI controller."* When three keys are actually down
the line goes from dim to lit and adds the count. The engine itself is
polyphonic; the hardware is not, and the interface says so rather than letting a
producer find out by having a chord swallowed (OPEN_QUESTIONS 45).

## 4. The four AI roles, and where each one is seamed

They are four different problems and they are seamed four different ways. Three
of them are measurement, not inference, and saying so is part of the design:
a model call there would be a guess dressed up as help.

**1. Where the cuts go — `slices.ts`, pure, no model.**
`suggestMaterial(report)` reads the material from what was measured (a measured
break, a long record with sections, chords with no break) and says which
measurement decided. `proposeSlicePoints` then uses the method that material
deserves: onsets for a break, chord changes snapped to the nearest note start
for melodic material, section edges for a phrase. Every point carries
`{ timeS, reason, method, confidence, origin }` — "Onset on a measured downbeat
at 0.000 s", "Note start nearest the change to Fm7", "chorus starts at 48.000 s,
bar 25". Nothing is cut until the producer presses Cut; the points are dragged
(`moveSlicePoint`, which cannot cross its neighbours), added or removed first,
and `markersFor` hands the existing manual chop route the markers it already
takes, so no new backend. A moved cut becomes a `SliceCorrection` against what
was proposed (principle 7). Honesty detail: the onset detector reports no
confidence of its own, so an onset-only cut carries 0.5 and the panel says why;
a cut that also lands on a measured beat inherits the beat tracker's confidence.

**2. Which key gets what — `kitOrder.ts`, pure, no model.**
`classifySlices` puts each slice on its step of the measured drum pattern
(`drums.patterns[].kick/snare/hat/other`, which is already folded per section on
a 16th grid) and takes the class whose `frequency` at that step is highest,
carrying that frequency as the confidence: *"Step 5 of the measured pattern is a
snare in 90% of that section's bars."* Orders offered: hit class, pitch (from
the chord measured under the slice), position, length, file. Every pad gets a
one-line reason. A drag swaps two pads and produces `KitOrderCorrection`s
against what was proposed. When nothing can be classified the kit stays in file
order and the panel says why — it never invents a class to have something to
sort by.

**3. Clean up a take — `cleanup.ts`, pure, no model.**
`cleanTake(take, settings, { tighten, collapseFlamsMs, flagOutliers })` returns a
`CleanedTake` that **carries the played take in `source`** and a `TakeChange` for
every hit it touched. Tighten is an amount, not a switch: each hit moves that
fraction of the way to its 16th, so 40% keeps the feel and loses the accident.
Flams collapse to the earlier time keeping the louder velocity. Flagging moves
nothing: a hit more than a third of a 16th from its step, or the only hit on its
pad in a busy take, is pointed at and left alone. (The obvious flag — "further
than half a 16th" — can never fire, because a hit is always placed on the
*nearest* step. That is a flag that would have looked like it worked.) The
producer chooses Played, Cleaned or a variation, and only what they choose goes
to MIDI or to the session.

**4. Suggest patterns — `patterns.ts`, and this is where the model seam is.**
A variation is not a list of notes. It is a list of *operations over the
producer's own take*: `swap-bars`, `repeat-bar`, `drop-pad-in-bar`, `shift-pad`,
`thin-pad`, `reverse-bars`. That vocabulary contains no way to say "a hit here",
so a rhythm described in words cannot be expressed at all — which is principle 1
made mechanical rather than promised.

- `suggestPatterns(take, settings)` builds variations from the take itself with
  no model at all, and is what the button calls today.
- `PatternAdvisor` is the seam for a model: `patternRequest(...)` builds the
  payload — bpm, bars, pads with labels and hit classes, hits as bar/step/offset/
  velocity, an optional instruction, and the operation names it may answer in.
  **No audio, no URLs, no file ids** (asserted in the test). The response is a
  list of operations, which are then run *locally* over the producer's take by
  `applyOperations`, and the result is checked by `isRearrangementOf` before a
  producer can hear it: every pad must be one the take played, playing the slice
  it played, inside the take's own bars, and the hit count cannot balloon.
- Tested against fakes: a well-behaved advisor, an advisor that returns an
  invented `add-hit` operation (refused, with a line naming why), an advisor
  whose operations do not fit this take (refused), and an empty answer (refused).

No live API is called anywhere in this seam, and there is no model id in the
code.

## 5. The latency path, and how to measure it for real

The direction document's line is about 20 ms. The path has three parts and only
two of them are ours:

```
keydown ──(input)──▶ handler ──(schedule)──▶ source.start(now) ──(output)──▶ speakers
```

- **input** — `performance.now()` in the handler minus `KeyboardEvent.timeStamp`.
  The OS scan, the browser's event loop, and anything blocking the main thread.
- **schedule** — **zero by design.** A pad starts at `ctx.currentTime`, never on
  a lookahead. (The session transport schedules 250 ms ahead because it is
  playing an arrangement; an instrument cannot.)
- **output** — `AudioContext.outputLatency` where the browser reports it, else
  `baseLatency`. On a laptop this is usually the largest part and no code
  shortens it.

`latencySample()` adds the three, `LatencyStats` keeps a bounded rolling window,
and `KitControls` prints the median and the 95th percentile with the verdict
("inside the 20 ms that feels played" / "past"). The 95th is what a producer
feels, so that is what is shown. An implausible event timestamp (a stale or
coarsened clock) is reported as unknown rather than as zero, and the total is
then marked partial instead of being a lie.

**How to measure it properly**, which this repo cannot do: play the laptop's
output into an interface, record the room mic and the line output on two tracks,
tap a pad with a hard fingernail click on the key, and measure the distance
between the key click and the slice's transient in the recording. That is the
whole path including the speaker. Do it on battery and on mains, with and
without a DAW open, and on Chrome and Safari — `outputLatency` is honest on
Chrome and Firefox and absent on Safari, where `baseLatency` is the floor and
the real number is larger. A second, cheaper check: `getOutputTimestamp()`
against `currentTime` while holding a key down, which shows the graph's own
offset without the speaker.

## 6. Plugging into the session

`takeToSession.ts` turns a finished take into one `SessionTrack` and one
`SessionRegion` per hit, and reads `lib/session/**` without changing a line of
it. `TakePanel`'s "Keep it in the session" then:

1. `session.adoptTempo(bpm, beatsPerBar)` — the session takes the take's tempo
   only if it has none;
2. `takeStartFor(session.position(), tempo.bpm)` — the take lands on **the next
   bar line at or after the playhead**, on the session's clock, so it sits in
   time with whatever is playing. With no measured tempo it lands at the
   playhead and the readout says so rather than inventing bars;
3. `session.edit(addTrack(...), "keep the played take")` — one lane, undoable,
   reconciled by the session's own planner while the transport keeps running;
4. `session.warm(fileId)` for each slice, so the lane decodes and joins.

Every region carries `lineage` back to the slice, the record it was cut from,
the take's tempo, and a reason that names the pad and the transposition. Gate
hits get the length the key was held; one-shot hits get the slice's own length
(a one-shot's hold time is deliberately *not* recorded as a length — that is
asserted). If the session already runs at a different tempo, the take lands at
its own tempo, unstretched, and the line says both numbers. Nothing here
stretches audio; that stays a render on the compute side, the same line the
transport draws.

## 7. Everything the mouse does, a sentence does

`parseKeyboardCommand` is as narrow as `lib/session/commands.ts` and refuses
anything with a question word or a conjunction — there is a test that walks
eight real conversational sentences ("why does gate mode click", "should i use
gate or one-shot for drums") and asserts every one is left alone for the model.
`swap pads 3 and 5` is the single exception, matched before the guard.

Covered, and each one moves the same control the mouse moves: gate / one-shot,
note / chop, every layout, the root key, play a pad, propose cuts (by material),
cut, add / move / remove a cut, all five kit orders, swap two pads, record *n*
bars, stop, clear, click on/off, save as MIDI, tighten by a percentage, collapse
flams on/off, clean up, keep the played or the cleaned take, suggest patterns,
use variation *n*, keep the take in the session, all off.

The panel has its own command line so this works today. It parses and puts the
command on `crateai:keyboard-command`; the panel applies it and emits one line
back on `crateai:keyboard-command-result`. **Wiring the chat is two lines** in
`components/chat/ChatPane.tsx` (another agent's file): try
`parseKeyboardCommand(text)` before `parseSessionCommand(text)`, and
`emitKeyboardCommand(command)` instead of `emitSessionCommand`. The path a
sentence takes is then identical whichever box it was typed into, because it is
the same path.

## 8. Tests

`pnpm test`: **137 files, 1319 tests, all passing** (1155 in 122 files before
this work; 164 new in 15 files). Nothing existing was changed, skipped or
deleted — `keymap.test.ts`, `bindings.test.ts`, `recording.test.ts` and
`grid.test.ts` all pass untouched, which is what proves the Phase 3 mapping and
the Phase 3 grid maths did not move.

| area | file | what is asserted |
|---|---|---|
| layouts | `lib/pads/layouts.test.ts` (8) | five presets, no repeated key, every pad round-trips, `R` is pad 12 in every layout that has the top row, rows drawn as the hand sits, the `16` preset is byte-for-byte Phase 3's map, which shortcuts each layout takes |
| note mode | `lib/pads/note.test.ts` (6) | the rate at 0, ±5, ±7, ±12 semitones, duration coupled to pitch, clamping and nonsense, the root in the middle of 8/16/24/40, note names from sharps and flats |
| held keys | `lib/pads/held.test.ts` (5) | one start then repeats forever, with and without the browser's flag; play again after a real key-up; a repeat with no press taken as a press; release-all; the peak held |
| engine | `lib/pads/engine.test.ts` (15) | one-shot ignores the key-up; gate releases with a 2 ms fade and no hard stop; release only that pad; release everything on lost focus; a release with nothing sounding; note mode's rate and the voice being exactly that much shorter; silent-not-late when undecoded; one decode shared, failures remembered, `forget` retried; usable after dispose |
| the instrument | `lib/pads/instrument.test.ts` (15) | repeat ignored (flagged or not), plays again after key-up, gate reports the held time and one-shot reports that it is not a length, stray key-ups, blur mid-hold, layout change mid-hold, note mode plays the root's slice on every key, moving the root moves every key, a key maps through the kit's own layout, the three-key ceiling |
| latency | `lib/pads/latency.test.ts` (7) | the three parts added, an unusable timestamp reported as unknown, a lookahead counted, median and 95th rather than the mean, nothing claimed before anything is measured, the 20 ms line named either way, a bounded window |
| the kit | `lib/pads/kit.test.ts` (10) | the Phase 3 defaults, switching modes changes nothing else, a growing layout keeps its slices and re-centres the root, a moved root survives, clamping, swap, `applyOrder` and the pad number always saying where a slice sits, any pad count, empty pads |
| where the cuts go | `lib/pads/slices.test.ts` (15) | material read from measurements and named; onsets with beat/downbeat confidence inherited; chord changes snapped to note starts; section edges with their bar; fallbacks that say so; the strongest N kept; a span; a drag that cannot cross its neighbours; add/remove; the markers the chopper takes; the correction payload |
| which key gets what | `lib/pads/kitOrder.test.ts` (9) | class from the measured step with its frequency as confidence; "cannot classify" said rather than guessed; kicks-snares-hats; pitch from the chord under the slice; position and length; always one entry per pad with no duplicates; the correction payload; slices built from the bindings |
| clean up a take | `lib/pads/cleanup.test.ts` (12) | tighten by exactly the fraction asked for; a half-tightened take still off the grid; flams collapsed to the earlier time keeping the louder; two pads never collapsed; the flag that fires and the one that cannot; the played take surviving in `source`; a line per change; nothing to say about a tidy take |
| patterns | `lib/pads/patterns.test.ts` (17) | the guard passes a rearrangement and refuses an unknown pad, a swapped slice, a hit outside the bars and a ballooning count; each of the six operations; an operation that does not fit rejected with its reason; suggestions all passing the guard; the request carrying no audio or file ids; a model's operations run locally; a model inventing a rhythm refused; a model's operations that do not fit refused |
| the session | `lib/pads/takeToSession.test.ts` (11) | the next bar line, the no-tempo case; one region per hit at the second played; gate length vs the slice's own; the region floor; note mode as `rate` with the matching duration; lineage back to the record; a hit with no decoded slice counted out; never before zero; the lane; the tempo mismatch said plainly |
| the command line | `lib/pads/commands.test.ts` (17) | every command form; eight conversational sentences left alone; "swap pads 3 and 5" matched despite the conjunction; a line for every command |
| the keyboard layer | `lib/keys/commands.test.ts` (8) | every Ctrl/Cmd/Alt combination left alone on both keydown and keyup; typing left alone; the default sixteen with no instrument; the layout winning over the `D` shortcut while mounted and giving it back on unmount; repeat and timestamp carried; pad-up for pad keys only; space and the loop keys still routed |
| the grid and controls | `components/keyboard/KeyboardGrid.test.tsx` (9) | four rows of four with their caps; forty keys for the full layout; "decoding" rather than a pad that will not sound; intervals and note names in note mode; a held key marked; the polyphony ceiling in the interface; the measured latency against the 20 ms line; the shortcuts a layout takes over; the mode described in the words it was chosen by |

`pnpm typecheck`, `pnpm lint` and `pnpm build` are all clean.

## 9. What only a browser and real hands can confirm

In this order, because each one is a different failure:

1. **Gate feels like gate.** Tap between two keys fast in gate mode, holding
   each for a moment. Every release should be silent — no click, no tail. If a
   release clicks, `PAD_RELEASE_S` is too short for that material; 2 ms is the
   floor that still feels like a cut.
2. **Alt-tab mid-hold.** Hold a key, alt-tab, come back. Nothing should be
   sounding and the key should play again on the next press. Repeat with: switch
   browser tabs, click into the chat box, press Cmd-Tab and release the pad key
   while away, and change the layout while holding a key.
3. **The repeat.** Hold one key for ten seconds in one-shot. It should fire once,
   not sixty times. Then in gate: one note, held.
4. **Note mode across the range.** Play the root and two octaves either side.
   The bottom should be recognisable and the top should be a chipmunk — that is
   correct, and it is the sound the producer asked for. Check the length
   shortens with the pitch.
5. **Key to sound.** Play the pads for thirty seconds and read the line under
   the controls. If the 95th is past 20 ms, check `outputLatency` first (it is
   usually the whole story), then whether a render is blocking the main thread —
   the input part of the readout is the tell. Then do the recorded measurement
   in section 5; the on-screen number cannot see the speaker.
6. **The ceiling.** Try a three-note chord on `1`, `2`, `3`, then on `Q`, `W`,
   `E`, then on `1`, `W`, `D`. Some combinations will drop a key and that is the
   keyboard matrix, not the code. Confirm the line under the controls lights when
   three are down, and that nothing hangs when a key-down arrives with no key-up.
7. **Bigger layouts under real hands.** 24 and 32 keys with the file surface
   open: confirm `D` plays a pad and does not move the downbeat, and that the
   line saying so is visible before they find out.
8. **A take into the session.** Record two bars over a playing session, press
   "Keep it in the session", and confirm the lane arrives on the next bar line
   and in time. Then do it with the session at a different tempo and read the
   line that says so.
9. **Gate lengths on the timeline.** Record in gate mode with long and short
   holds, keep it, and look at the region lengths — they should be the holds, not
   sixteen identical slices.
10. **The command line in anger.** Type the sentences from section 7 and check
    each one moves the visible control, and that a question is never swallowed.

## 10. Decisions taken, and why

- **`PadEngine` got a backend interface rather than a mock of Web Audio.** Same
  shape as the session transport. Gate, repeat, release and note mode are all
  asserted in node at exact times; the browser half is 146 lines of node
  plumbing with no decisions in it.
- **The release is 2 ms and the attack is still 3 ms.** The attack is Phase 3's
  and was already right; the release is shorter because a key-up should feel
  like a cut, and at 2 ms it is silent on every slice tried in the maths.
- **Note mode transposes by resampling and says so.** Pitch and duration stay
  coupled. The direction document is explicit that time-stretching with pitch
  held is a render, not a playback trick, and the transport already draws that
  line for the rack; the instrument draws it the same way.
- **The layout resolver is registered, not global.** With no instrument mounted
  the shortcuts are exactly what they were. A producer on the Loops tab still
  gets `L` and `D`.
- **A tap gets a length in gate mode.** A pointer click, a chop-list play
  button and "play Q" all press and release in the same instant, which in gate
  mode is silence. A tap holds for 300 ms (`TAP_HOLD_MS`); a real pointer-down
  and pointer-up on a pad is unaffected and gates exactly as the key does.
- **Velocity is still always 1.0.** A computer keyboard has none. A velocity
  curve from key-down timing would be a measurement we did not take.
- **Gate note lengths ride beside the MIDI payload, not in it.** `/api/midi/pads`
  takes `PadHitInput` and is another seam's file, so `length_s` and `semitones`
  live on `TakeHit` and reach the session directly. Saving to MIDI is unchanged.
- **Three of the four AI roles need no model call**, and the code says so where
  it would otherwise look like an omission. The seam exists where a model
  genuinely adds something — proposing variations — and even there the model
  chooses operations, never notes.
- **The kit is per-surface state and is not persisted.** Reloading the file
  surface gives the Phase 3 defaults (16 keys, one-shot, chop). Persisting it per
  file is a `localStorage` line or a column, and deliberately not guessed at
  here.
- **The panel carries its own command line.** The chat wiring is two lines in a
  file another agent owns, and the instrument should not be unusable by sentence
  until that lands.

## 11. One file outside the seam

`web/components/surface/ChopsTab.tsx` is not in this seam's ownership and was
edited, in one hunk, because the instrument needs a mount point: the left column
now renders `<KeyboardPanel />` instead of `<PadGrid />` + `<RecordPanel />`, and
the tab computes `baseBindings` (file order) and `bindings` (the kit's order)
and passes both. Nothing else in the file changed — the chop controls, the chop
list, the MIDI panel and every other prop are as they were. If it conflicts, the
merge is: keep the other side's file, replace the pad column's contents with the
`KeyboardPanel` block, and add the two `useMemo`s and the `useKit()` line.

## 12. What is not done

- **Choke groups.** An open hat that cuts the closed hat is a kit-level
  relationship the engine could express with one map (`chokeGroup: number` on a
  binding, release the group's voices on `noteOn`). Nothing today chokes
  anything; every pad is polyphonic against itself.
- **Per-pad gain, tuning and reverse.** The direction document's per-track
  corrective processing lands on the session first; when it does, a pad's own
  trim belongs in the kit next to it.
- **Web MIDI.** Queued for Phase 13, and this work is the argument for it: the
  engine is polyphonic, the keyboard is not, and everything here (`noteOn`,
  `noteOff`, velocity, `semitones`) already has the shape a MIDI note-on wants.
  `velocity` is carried end to end and only ever set to 1.0 by the keyboard.
- **Persisting the kit**, and persisting a take as a library row. The take lives
  in the session and as MIDI; it is not a `takes` table.
- **The corrections route.** `SliceCorrection` and `KitOrderCorrection` are
  built and counted in the panel, and nothing writes them, because `web/app/api/**`
  is another seam. They are shaped like `corrections` rows (`field`, predicted,
  corrected, method, confidence, the reason kept verbatim).
- **A model advisor implementation.** `PatternAdvisor` has no live
  implementation, by instruction; the fake in the tests is the contract.
- **The shell's pad toast.** `Workspace.tsx` still shows "pads fill with chops in
  Phase 3" on every pad key; it is cosmetic, it is in another seam's file, and it
  is now wrong. One line to delete when that file is next open.
- **`web/lib/session/**` was read, not audited.** Nothing in it was changed and
  no bug was found in what this work touched: the clock, `addTrack`, `edit`,
  `warm`, `adoptTempo` and `position` all behaved exactly as the transport
  handoff describes.
