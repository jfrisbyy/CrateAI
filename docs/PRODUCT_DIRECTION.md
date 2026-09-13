# PRODUCT_DIRECTION.md — Cratebox AI

Owner direction, recorded 2026-09-13 after the first real flip made in this
system (a Masquerade loop under an In The Shade break). Supersedes the
working name in `CLAUDE.md`. Nothing here is built yet; this is the shape the
finished product takes, and the phase plan below says where each piece lands.

## The name

**Cratebox AI.** A producer's crate, in a box. `lockedgroove` stays as the
Python package name until a mechanical rename is worth the churn; the UI, the
domain and the copy say Cratebox.

## What the first real session taught us

The flip worked. The loop was right, the drums locked, the tempo fitting held.
The owner's verdict on the result was still "it works, it's just not a song I
love" — and the diagnosis was correct and important: **that is a crate
problem, not a pipeline problem.** Five records went in, one had drums worth
using, and the system picked it correctly.

The failure was not the choice. It was that the owner never got to *hear* the
five candidates. A ranked table of percussive fractions is the right way for
the machine to decide and the wrong way for a producer to decide. A producer
decides by pressing play.

So the central product rule:

> **A result you cannot hear is not a result.** Anything the system finds,
> separates, chops, layers or re-voices arrives as an object you can play,
> compare against its neighbours, and drag into the song — in the same window,
> without a download and without a round trip.

This is principle 4 ("every output is editable") taken seriously. Editable
starts with audible.

## Surface 1: the candidate rack

When the ask is "find me drums", "find me a bassline", "what in my crate fits
this", the answer is a **rack of playable candidates**, not prose.

Each candidate row carries:

- A waveform with the region marked, and a play button that starts on the
  downbeat, not at the file's zero.
- The measurement that earned it a place, with its confidence and hedge: "92
  BPM, +3.9% to fit", "vocal-free, 0.86", "relative minor".
- **Solo against the current song.** The single most useful control: play this
  candidate *underneath what I already have* so the choice is made in context
  rather than in isolation. Loop it, A/B the next one on the same bar.
- Provenance: which record, which timestamp, which separation model, so the
  producer can go back to the source.
- One click to commit it to the song as a track.

Ranking still happens — the rack arrives in a sensible order with the reason
shown — but ranking is a suggestion, and the producer's ear is the decision.
When they pick third instead of first, that is a `corrections` row
(principle 7) and the ranking learns.

## Audio quality is a first-class requirement

The second session produced three melodic layers and the owner's verdict was
that they sounded muddy and muffled. Measured, the loss has three sources and
they are not equally excusable.

| Stage | 8-20 kHz, relative | Verdict |
|---|---:|---|
| Moonlight Highlife, as uploaded | -19.5 dB | the material |
| after `kuielab_a_other` separation | **-37.1 dB** | **our tooling** |
| after a 0.83 stretch and +6 semitones | -23.3 dB | our tooling |
| BS-Roformer on the same source | **-19.5 dB** | identical to the source |

**Separation quality is not a detail, it is the product.** A weak model
(`kuielab`, SDR ~7-10) threw away 17.6 dB of air that a strong one
(BS-Roformer, SDR 11.8) preserves exactly. Everything downstream — layering,
EQ, the producer's opinion of the whole system — inherits that loss and cannot
recover it. The rule:

> Never separate with a fast model to save compute. The separation is the
> irreversible step; spend the GPU there.

BS-Roformer took 4:15 for a 17-second clip on a CPU and would be seconds on
the A10G the product already plans for. This is a hosting decision, not a
research problem.

Two other quality rules that follow:

- **Source fidelity is worth surfacing.** The uploads in the test sessions were
  lossy: 12.0 kHz ceiling on the Masquerade record, 13.5-15.7 kHz on the rest.
  Nothing recovers content that was never in the file. The library should
  measure and display each file's real bandwidth, and say plainly when a flip
  is limited by its source rather than by the processing.
- **The phase vocoder is not good enough for the stretches this product asks
  for.** Ratios of 0.73 to 0.85 are routine when fitting one record to
  another, and librosa's vocoder smears them audibly. A real stretcher
  (Signalsmith, or Rubber Band under licence) is not optional polish; it is on
  the critical path. See OPEN_QUESTIONS 27.

## Surface 2: the song

The owner is right that this becomes a DAW to a degree, and right to be wary
of it. The line, stated plainly:

**In scope — arrangement and audition.** A running multitrack view of the song
as it is being built: tracks stacked, regions on a timeline, transport with
loop and locators, drag to move, trim edges, mute, solo, gain, a tempo and key
header the whole session obeys. Play the whole thing. Edit inside that window.

**Also in scope — corrective processing. (Revised 2026-09-13.)** The earlier
draft of this document put all processing out of scope. The owner pushed back
and was right, and the second session proved it: a separated trumpet came back
dull, and with no way to open it up the only available verdict was "all three
of these suck". A producer with an EQ would have fixed it in ten seconds. If
the answer to every blemish is "bounce it and open Ableton", the loop that
makes this product worth using is broken every time something needs a touch.

So: per-track EQ, filters, gain staging, tuning, transient shaping, and a
bus that can be levelled and gently limited. Heard in isolation, soloed, or
in context.

**Still out of scope — being a better DAW than the DAWs.** No plugin hosting,
no third-party format support, no deep automation, no attempt to win a feature
comparison against Ableton or FL Studio. We are not competing on the console.

The line is now drawn differently, and more usefully:

> **In: anything that answers "does this fit, and can I make it fit?"**
> **Out: anything that is production for its own sake.**

An EQ that rescues a muddy horn so it can sit under a loop answers the first
question. A mastering chain for release does not. The difference is not the
tool, it is what the producer is deciding when they reach for it.

**The differentiator is that the AI drives these tools.** "This trumpet sounds
awful, clean it up" should produce a real, visible, editable EQ curve — not a
black box, and not a menu the user has to learn. Every processor the product
offers must be equally reachable by sentence and by mouse, and whatever the
sentence does must show up on the control the mouse would have used. That is
the thing FL Studio cannot do, and it only works if the tools are in the room.

**Rough, then refine.** The owner's phrasing, and it is the product thesis:
slice something to an approximation, drag it roughly into place, then say
"tighten that up" or "make this sit under the horns". The working window
exists so the rough pass is possible; the AI exists so the refinement is one
sentence. Neither half works alone.

Everything on the timeline stays traceable to the audio it came from. A region
knows it is bars 9-16 of a record, pitched +62 cents, stretched to 0.964. That
lineage is what makes the breakdown, the corrections table and principle 1 work,
and it is what a normal DAW throws away.

## Surface 3: the layout

Start as a chat page. As objects appear, the window adapts: a panel slides in
from the side the way a Claude artifact does, and the chat narrows to make
room. Racks, the song, a waveform, a piano roll all share that space.

The rules that keep it from becoming a mess:

- **One surface at a time, with history.** The panel shows the object under
  discussion. Going back to an earlier one is a click, not a re-run.
- **The chat stays the command line.** Everything the panels do by mouse can be
  said in a sentence, and everything said in a sentence shows up in the panel.
  Neither is the "real" interface.
- **Resizable and dismissible.** Drag the divider; collapse the panel and get
  the full-width chat back. The layout is the producer's, not ours.
- **Nothing modal.** Audition never blocks the chat. A render in progress never
  blocks playback of what is already there.

## What this needs technically

The pieces that exist: `LoopPlayer` (Web Audio, raw and rendered preview),
`decode.ts`, `renderLoop.ts` with its sample-exact TypeScript port, wavesurfer
with server-side peaks, the surface tab shell, and the whole analysis and
separation pipeline behind it.

The piece that does not exist is a **session transport**: one clock, tracks as
gain nodes on a shared bus, regions scheduled ahead of the playhead, sample
accurate across loop points, tolerant of a track still decoding. That is the
foundation both surfaces stand on, and it should be built once, deliberately,
before either is dressed up. Everything else is layout on top of it.

Two known consequences:

- Decoded audio is memory-hungry. A session with a dozen tracks of a
  four-minute record needs a decode cache with eviction, and probably
  peaks-only rendering for tracks that are not currently soloed.
- Auditioning candidates under the song means decoding several at once. The
  rack should decode lazily on hover or first play, not on arrival.

## Where it lands in the plan

| Piece | Phase |
|---|---|
| Session transport (clock, tracks, regions, scheduling) | new Phase 11, before the rest |
| Candidate rack, with solo-against-the-song | Phase 11 |
| Song timeline: arrange, trim, mute, solo, gain | Phase 12 |
| Adaptive chat/panel layout | Phase 12, with both surfaces as its first tenants |
| Per-track corrective processing (EQ, filter, gain, tune) driven by chat | Phase 12 |
| External input: MIDI controllers and keyboards via Web MIDI, audio in | Phase 13 |
| Export to stems and a DAW-importable session | Phase 13 |
| Rename to Cratebox across the UI and docs | any time; mechanical |

The existing audition proposals in `PROPOSALS.md` — "Preview mix of a layer
before rendering", "Audition a fact's span", "Audition the edited MIDI in the
browser" — are all the same feature seen from three tabs. They collapse into
the session transport and should be built as one thing, not three.

## Surface 4: the keyboard as the instrument

Decided with the owner 2026-09-13. Phase 3 already ships part of this: sixteen
pads on `1`-`8` and `Q`-`I` in a 4x4 grid, a `PadEngine`, chop modes for
transients, grid and manual, and a recorder that captures a take as MIDI with
its real timing. What follows is the expansion, and every axis is a mode the
producer picks rather than a decision we make for them.

### Trigger behaviour: one-shot or gate, switchable

**One-shot** fires the whole slice to its end and ignores the key being held.
This is the MPC feel and what exists today.

**Gate** sounds only while the key is down and cuts on release. This is what
makes tapping between two keys to hunt a chop feel alive, and it is the mode
the owner described. It needs note-off, which the engine does not have.

The switch lives per kit, because drums want one-shot and a melodic slice
usually wants gate.

Two hard details:

- **OS key repeat must be suppressed.** A held key fires `keydown` over and
  over; in gate mode that retriggers forever. Track held keys and ignore
  repeats, and release on `keyup`, on `blur`, and on tab visibility change,
  or a note hangs the moment someone alt-tabs mid-hold.
- **Release needs a short fade**, a couple of milliseconds, or every key-up is
  a click.

### Chop mode or note mode, toggleable

**Chop mode**: each key is a different slice. What the pads do now.

**Note mode**: every key plays the *same* slice transposed, so a single stab
or chord becomes an instrument you can play a melody on. Implement it the way
a sampler does, with `playbackRate = 2 ** (semitones / 12)` on the source
node. Pitch and duration stay coupled, which is not a compromise here: it is
the sound of a sampler and it is what the producer expects.

The root key sits in the middle of the layout so there is room either side.

### Layout is the producer's choice

The owner asked for full-keyboard optionality with switchable sizes, so
layouts are named presets over one pure mapping function:

| Preset | Keys | For |
|---|---|---|
| 8 | number row | a break in eighths, coarse and instantly memorable |
| 16 | `1`-`8`, `Q`-`I` (today's 4x4) | the default |
| 24 | number row plus two letter rows | a longer phrase |
| 32+ | number row plus three letter rows | the deepest chopping, two-handed |

The mapping from key to pad must stay a pure function so the on-screen grid,
the engine and the recorder can never disagree about what `R` means.

**The constraint that decides the ceiling:** a laptop keyboard registers only
two or three simultaneous keys in arbitrary combinations. More keys buys more
*slices*, never more polyphony. Chords are a controller feature, not a laptop
feature, which is the strongest argument for the Web MIDI work already
queued. Say this in the interface rather than letting a producer discover it
by having a chord swallowed.

### Where the AI helps: all four, and they are different problems

**Where the cuts go.** Transients for drums, note starts for a melodic
sample, section edges for a long phrase. The existing onset, beat and
structure work already produces these; the job here is to propose them as
draggable slice points with a reason attached, never to place them silently.
Material decides the method, which is why the answer differs for a break, a
horn line and a live instrument.

**Which key gets what.** A pile of slices in file order is not a kit. Drums
sort by hit class, which `drums.py` already classifies, so kicks land
together. Melodic slices sort by pitch or by position depending on the mode.
The producer reorders by dragging, and that reorder is a correction worth
logging.

**Clean up a take.** The recorder keeps real timing, so cleanup is a pass
over it: tighten to the grid by a chosen amount rather than all-or-nothing,
collapse a flam into one hit, flag the bar that was clearly a mistake. Never
destructive; the played take survives alongside the cleaned one.

**Suggest patterns.** From what was just played, propose variations to accept
or ignore. This is the one place closest to the "nothing from nothing" line,
so it stays strictly rearrangement of the producer's own performance and
their own slices. It never invents a rhythm from a text description.

### What it plugs into

Chopping is performance input for the session. A take lands on a track in the
timeline, not in a separate toy. It needs the session transport for its clock
so a recorded take sits in time with everything else, which is why this comes
after that work rather than beside it.

Two known constraints to measure early rather than discover late: keyboard to
audible sound wants to stay under about 20 ms to feel played rather than
triggered, and browser shortcut collisions (`Ctrl`/`Cmd` combinations) have to
be handled without swallowing the keys people expect to work.

## Build order, decided 2026-09-13

The owner set this sequence. Each step depends on the one before it, which is
why they are not parallel.

**In flight now, four independent tracks:**

1. **Audio quality chain** — best-available separation with no fast mode, a
   real time stretcher, measured source bandwidth surfaced to the producer,
   and a harness that fails if the chain gets lossier.
2. **Session transport and the audition rack** — the Web Audio engine
   (clock, tracks, regions, scheduling, loop points, mute/solo/gain), the
   rack of playable candidates with solo-against-the-session, and the
   adaptive chat-to-panel layout.
3. **Launch readiness** — free-tier limits that survive contact with free
   users, model routing by task, prompt caching on the system block, spend
   metered into one table, and a preflight script.
4. **Sample-pair evaluation** — somewhere to put the owner's original-plus-flip
   pairs, and the metric that asks whether our finder locates the section a
   producer actually used.

**Then, in order:**

5. **The song timeline.** Arrange, trim, drag regions, transport across the
   whole song. Needs the session engine from (2) to exist first. Together
   with the rack this is the product: the rack is how you audition, the
   timeline is how you decide what the song is. Regions keep their lineage
   back to the record and the transform, which is the thing a normal DAW
   throws away and this one cannot afford to.
6. **The keyboard instrument** (Surface 4 above). Depends on the session
   transport for its clock, not on the timeline, but lands after it so a
   recorded take has somewhere to go.
7. **A clickable, deployable prototype.** The layout running end to end with
   real interaction, so the owner can feel it rather than read about it.
   Deliberately last, because a prototype of surfaces that exist is worth
   more than a mockup of ones that do not — and by then the chop surface is
   in it, which is the part most worth playing with.

Per-track corrective processing (EQ, filters, tuning) follows, its shape
informed by what the timeline makes obvious.

## Open questions this raises

38. **Session persistence.** Is a song a first-class library row with its own
    table (tracks, regions, edits), or a document blob? A table makes the
    chat able to reason about the arrangement; a blob is faster to ship.
    *Assumption:* a table, because "what's in bar 17" should be answerable.
39. **How much of the song does the chat see?** Embedding a full arrangement
    in the system prompt is expensive. *Assumption:* a compact summary of
    tracks and regions, with a tool to read any region in detail.
40. **Export target.** Stems plus a tempo map covers every DAW. A native
    session format (.als, .flp) covers one each. *Assumption:* stems, a
    tempo map and a readme first; native formats on request.
