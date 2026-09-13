# CLAUDE.md

Working name: **lockedgroove** (placeholder; rename when the product name is final).

## What this is

A hosted web application that is the AI platform for producers. Not an AI that makes music. An AI that makes making music easier for the person doing it.

Users sign in, upload the audio they work with, and get a workspace shaped like claude.ai: a chat pane, a library, and a working surface where everything the system produces shows up as an object they can grab and change. The system measures audio with DSP and pretrained models, remembers everything in a library that gets more useful the more they bring in, finds loops, separates stems, chops, extracts MIDI, layers material from different files, re-voices a part in another instrument, breaks down how a beat was made, and searches the web for information a producer would otherwise go dig for. The chat can do any of it by sentence and explain any of it, and it only ever explains from what was actually measured or actually found.

Read `docs/BUILD_PACKET.md` in full. It has the vision, the principles, the architecture, the plan, and the process for proposing things that aren't in it yet.

## The principles

These define what the product is. They are not the same as a feature list, and they're not a fence.

1. **Nothing from nothing.** Every output is derived from audio the user brought. Layering drums from one record over another, re-voicing a piano line as guitar, chopping, stretching, pitching, combining: all in. Generating a beat, a melody, or a sample from a text description with no source material: out. That's the difference between us and AI music apps, and the reason producers will trust this.
2. **Measure, don't guess.** Every analysis value carries `method` and `confidence`. The chat states musical facts only from the AnalysisReport, and states world facts only from web results it can cite. If neither source has it, it says so. This is enforced in the system prompt and tool schemas.
3. **Read the internet, never download audio from it.** Web search and page fetching for information are in: who produced a record, what it sampled, what sampled it, what gear was used, interviews, tutorials. Downloading or processing audio or video from any URL, stream, or platform is out, in code, always. Users bring files.
4. **Every output is editable.** Loops have draggable edges. BPM has halve, double, and tap. Key shows an alternate. Downbeats can be set by hand. Chops are movable. Layers have offsets and gains. A re-voiced part comes back as MIDI plus audio so the notes can be fixed. If a feature produces something the user can't correct, it isn't done.
5. **The library is the product.** Every operation deposits into it; every operation can search it. Files, stems, chops, loops, layers, and re-voiced parts are all first-class library entries with their own analysis.
6. **User audio is private, always.** Per-user storage prefixes, row-level security on every table, signed URLs with short expiry, no public buckets, no cross-user access to uploaded audio. Exports are downloaded by the creating user only.
7. **User corrections are ground truth.** Every edit to a predicted value logs the prediction and the correction. That table is the accuracy dataset. It is used for nothing else and never crosses users.
8. **Tests before DSP.** Every function in `analysis/`, `loops/`, `combine/`, or `revoice/` gets a pytest test against a synthetic fixture before it's wired into a job.
9. **The accuracy harness gates merges** for anything touching analysis.

## Proposing what isn't in the packet

The packet is the basis, not the boundary. While building, you will see features, tools, and shortcuts that would make a producer's flow easier. Propose them. Append to `docs/PROPOSALS.md` using the template there: what it does, which principle it serves, which principle it risks, what it would take, and where in the phase plan it belongs. Don't build it in the current phase unless it's small and clearly inside the phase's acceptance line. The owner reviews proposals between phases and promotes the ones that fit.

The test for a proposal: does it make the human's beatmaking faster, better, or more understood, without making the beat for them?

## Stack (decided)

- **Web:** Next.js 15 App Router, TypeScript strict, Tailwind, on Vercel.
- **Auth, DB, storage, realtime:** Supabase. Postgres with `pgvector`. Storage with tus resumable uploads. Realtime for job status. RLS on everything.
- **Compute:** Python 3.11 on Modal, one function per stage, GPU for separation, embeddings, and neural re-voicing; CPU otherwise. Invoked from Next.js server routes; results written back with the service role.
- **Language:** Anthropic API from server routes, streaming, tool use.
- **Web information:** a search API (Brave or Tavily) plus page fetch for citation, wrapped as chat tools. Never a media download path.
- **Python libs:** `librosa`, `soundfile`, `numpy`, `scipy`, `pyloudnorm`, `audio-separator`, `basic-pitch`, `laion-clap`, `pretty_midi`, `pyfluidsynth` with open soundfonts / SFZ instruments for symbolic re-voicing, `pyrubberband` or `signalsmith-stretch` for stretch and pitch, `pydantic`. `ffmpeg` in the Modal image.
- **Frontend audio:** `wavesurfer.js` v7 + Regions; Web Audio for playback and client-side loop preview.
- **Package management:** `pnpm`, `uv`. **Migrations:** Supabase CLI.

## Repo layout

```
CLAUDE.md
docs/
  BUILD_PACKET.md
  PROPOSALS.md
  BACKLOG.md
  analysis_report.schema.json
web/
  app/  components/  lib/{supabase,anthropic,audio,search}/  package.json
analysis/
  pyproject.toml
  lockedgroove/
    report.py  ingest.py  modal_app.py
    analysis/   tempo.py beats.py key.py chords.py onsets.py groove.py loudness.py spectral.py effects.py structure.py drums.py sampleuse.py tags.py
    loops/      finder.py render.py
    stems/      separate.py
    chops/      chop.py midi.py
    combine/    align.py layer.py
    revoice/    symbolic.py neural.py
    breakdown/  compose.py compare.py
    embeddings/ clap.py
    beatbox/    train.py transcribe.py
  tests/fixtures/
supabase/migrations/
scripts/  eval_accuracy.py  fetch_public_datasets.py
```

## Conventions

- Times in seconds as `float`; sample indices as `int`; suffix `_s` / `_samples`.
- Tempo as `float` BPM. Key as `{tonic, mode}`, sharps internally.
- `confidence` is always a float in `[0, 1]`.
- Every Modal function is idempotent on `(file_id, analysis_version)`.
- Commit small. One packet task per branch. PR descriptions list interpretation choices.
- When the packet is ambiguous, pick the simplest interpretation that meets acceptance, note it, continue. Don't stop to ask unless blocked.
