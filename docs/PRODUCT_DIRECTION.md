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

## Surface 2: the song

The owner is right that this becomes a DAW to a degree, and right to be wary
of it. The line, stated plainly:

**In scope — arrangement and audition.** A running multitrack view of the song
as it is being built: tracks stacked, regions on a timeline, transport with
loop and locators, drag to move, trim edges, mute, solo, gain, a tempo and key
header the whole session obeys. Play the whole thing. Edit inside that window.

**Out of scope — production processing.** No EQ curves, no compressors, no
automation lanes, no plugin hosting, no mixing console. Not because they are
hard, but because that is where FL Studio, Ableton and Logic already live and
where this product has nothing to add. The export goes there.

The test for any control: *does it help the producer decide what the song is?*
Arrangement does. A compressor does not.

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
| Export to stems and a DAW-importable session | Phase 13 |
| Rename to Cratebox across the UI and docs | any time; mechanical |

The existing audition proposals in `PROPOSALS.md` — "Preview mix of a layer
before rendering", "Audition a fact's span", "Audition the edited MIDI in the
browser" — are all the same feature seen from three tabs. They collapse into
the session transport and should be built as one thing, not three.

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
