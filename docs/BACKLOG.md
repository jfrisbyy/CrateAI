# BACKLOG.md

Deferred items and known gaps, by phase. Items move to the phase plan when
they're scheduled and out of here when they ship.

## Phase 0
- [ ] Google OAuth provider (needs dashboard setup; the code is a one-line addition on the login page).
- [ ] Folder upload on Safari (no directory drag-drop; the picker works).
- [ ] Files longer than 20 minutes: vitals only on the first 20 minutes, note in the job result and the header.
- [ ] Public datasets could not be downloaded in the build environment (egress policy); the fetcher's tarball extraction, md5 checks, and resume are code-reviewed but unexercised. First real run: `python scripts/fetch_public_datasets.py --dataset all`.
- [ ] Follow-up jobs (a stem's analyze, a render's analyze) are dispatched in-process; see the durable dispatch proposal.

## Phase 1
- [ ] Loop finder in beats mode (downbeat confidence under 0.5): hats on every 8th make `onset_lock` unable to prefer the downbeat; see the downbeat-likelihood proposal.

## Phase 2
- [ ] BeatNet weights are GPL-licensed; the `track_beats` interface is in place, the backend ships only if the license is acceptable for the hosted product.
- [ ] Meter detection (PROPOSALS).
- [ ] The stems job's band-split stand-in (`LOCKEDGROOVE_FAKE_STEMS=1`) is for development only and labels its rows `<model>-fake`.

## Phase 3
- [ ] Melody extraction (Basic Pitch) runs only on the compute image; the local runner reports the missing dependency.

## Phase 4
- [ ] A hat stacked under a snare is not separable by the rule-based hit classifier (the pattern shows the hat missing on those steps; narration rounds hat density so the words stay right). See the learned classifier proposal.
- [ ] Layered kick detection reports `null`; needs a second-spectrum pass.
- [ ] Pitch-shift estimation needs candidate sources with a stored chroma profile (proposal); today only candidates passed explicitly are compared.
- [ ] Saturation estimate is deliberately rough (odd-harmonic excess over the strongest fundamental) and capped at 0.3 confidence.

## Phase 5
- [ ] Web result cache eviction (24 h TTL is set; there is no size cap yet).

## Phase 6
- [ ] CLAP runs on the GPU image; the CPU analyze job leaves tags empty until the embed job runs.

## Phase 7
- [ ] Neural re-voice: DDSP/RAVE evaluation write-up pending; the path returns a clear "not shipped" reason.
- [ ] Signalsmith Stretch bindings are optional; the librosa phase-vocoder fallback is lower quality on transients. Confirm the licensing decision in OPEN_QUESTIONS H.27.
- [ ] FluidSynth and a General MIDI soundfont must be in the compute image for sampled re-voice renders; the additive fallback is preview quality and says so.

## Phase 10
- [ ] Backups: point-in-time recovery is a Supabase plan setting, not code; documented in the runbook.
