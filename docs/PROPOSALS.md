# PROPOSALS.md

The packet is the basis, not the boundary. Anything that would make a
producer's flow faster, better, or more understood, without making the beat
for them, gets proposed here and reviewed between phases.

Template:

```
## <name>
**What it does for a producer:** one paragraph, in their words.
**Principle it serves:** which of the nine.
**Principle it risks:** which, and how it's mitigated.
**What it takes:** stages, models, UI, rough effort.
**Where it belongs:** which phase, or a new one.
**Status:** proposed | accepted | deferred | declined, with the owner's note.
```

---

## Meter detection
**What it does for a producer:** Waltz-time soul records and 6/8 gospel loops stop getting a 4/4 grid forced on them. The grid, the loop finder, and the drum pattern read correctly without a manual override.
**Principle it serves:** 2, measure don't guess.
**Principle it risks:** Little. A wrong meter guess is worse than the 4/4 default, so it ships only with a confidence gate and the override stays.
**What it takes:** Bar-length autocorrelation of the downbeat-candidate energy over 3, 4, 6 (and 5, 7) beat groupings; one stage; harness cases from Ballroom waltzes.
**Where it belongs:** Phase 2+.
**Status:** proposed.

## Reference-driven mixing hints
**What it does for a producer:** After comparing my beat with a reference, tell me the specific moves: "your low end is 3 dB heavier below 120 Hz; your hats are 2x denser; your snare has 0.4 s more tail." Suggestions, not a mix.
**Principle it serves:** The learning goal; 2 and 4.
**Principle it risks:** 1, drifting into doing the mix. Mitigated by returning suggestions only, never applying them to audio.
**What it takes:** Band-wise loudness deltas from the comparison, a small rules layer, narration under the grounding contract.
**Where it belongs:** Phase 4+.
**Status:** proposed.

## Chop pitch matching
**What it does for a producer:** Each chop pitched to the song key automatically, editable per chop, so a kit is playable in key the moment it's cut.
**Principle it serves:** 4, every output editable; 5, the library.
**Principle it risks:** None serious; a bad pitch estimate is visible and reversible per chop.
**What it takes:** Per-chop pitch estimate (pyin on the chop), semitone shift with the stretch engine, a per-pad pitch field.
**Where it belongs:** Phase 3+.
**Status:** proposed.

## Session export to DAW project formats
**What it does for a producer:** Instead of a zip of WAVs and MIDI, an Ableton Live set, FL Studio project, or Logic project with the chops on pads and the MIDI on tracks, at the right tempo.
**Principle it serves:** Handoff; not a DAW.
**Principle it risks:** None; effort is the cost, and it is high per format.
**What it takes:** Ableton `.als` (gzipped XML) is documented enough to generate; FL and Logic need reverse-engineered formats. Start with Ableton.
**Where it belongs:** Phase 3+.
**Status:** proposed.

## Groove transplant
**What it does for a producer:** Take the measured swing and offsets of one record and apply them to the MIDI of another, so my programmed drums sit like the break I love.
**Principle it serves:** 2 and 4.
**Principle it risks:** 1, if applied to generated material. It only applies to MIDI derived from the user's audio or tapped on the pads.
**What it takes:** Groove template already measured in `groove.py`; a MIDI transform; a control on the MIDI export.
**Where it belongs:** Phase 3+.
**Status:** proposed.

## Shared kits
**What it does for a producer:** Publish a kit built only from re-voiced or synthesized material I own, so others can play it.
**Principle it serves:** 5.
**Principle it risks:** 6, user audio is private. Mitigated by a rights attestation flow and by allowing only `revoice_render` and pad recordings, never originals, stems, or chops of uploaded audio.
**What it takes:** A `kits` table with a public flag, an attestation step, a public read path for attested kits only.
**Where it belongs:** Phase 10+.
**Status:** proposed.

## Local compute runner
**What it does for a producer:** Nothing directly; it lets the owner run every job kind on a laptop without a Modal account, which makes development and testing of the analysis pipeline immediate.
**Principle it serves:** 8 and 9, tests before DSP and the harness.
**Principle it risks:** None; it is the same code behind the same dispatch contract.
**What it takes:** A FastAPI app in `analysis/lockedgroove/server.py` (built in Phase 0).
**Where it belongs:** Phase 0.
**Status:** accepted (small, inside Phase 0 acceptance).

## Tap tempo and count-in on the pads
**What it does for a producer:** Tap a tempo in the header, get a count-in click before record mode so the first hit lands on the one.
**Principle it serves:** 4.
**Principle it risks:** None.
**What it takes:** Client-only, Web Audio scheduling.
**Where it belongs:** Phase 3.
**Status:** proposed.

## Enharmonic key display
**What it does for a producer:** Keys show the way producers say them (Bb minor, not A# minor) with the alternate spelling on hover. Sharps stay internal.
**Principle it serves:** Understanding.
**Principle it risks:** None.
**What it takes:** A display helper in `web/lib/music/keys.ts`.
**Where it belongs:** Phase 0.
**Status:** accepted (small).
