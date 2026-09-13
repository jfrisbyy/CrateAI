# BACKLOG.md

Deferred items and known gaps, by phase. Items move to the phase plan when
they're scheduled and out of here when they ship.

## Phase 0
- [ ] Google OAuth provider (needs dashboard setup; the code is a one-line addition on the login page).
- [ ] Folder upload on Safari (no directory drag-drop; the picker works).
- [ ] Files longer than 20 minutes: vitals only on the first 20 minutes, note in the job result and the header.
- [ ] Public datasets could not be downloaded in the build environment (egress policy); the fetcher's tarball extraction, md5 checks, and resume are code-reviewed but unexercised. First real run: `python scripts/fetch_public_datasets.py --dataset all`.
- [ ] Follow-up jobs (a stem's analyze, a render's analyze) are dispatched in-process; see the durable dispatch proposal.
- [ ] CI installs `analysis[dev]` with `uv pip install` rather than from `analysis/uv.lock`; switch it to `uv sync --frozen` so CI runs the locked versions (numba 0.67, numpy 1.26, librosa 0.11 today).
- [ ] The synthetic gates for `bpm_exact` sit below the packet's 0.80 by design (the hip-hop tempo prior on a set whose tempos are uniform over 65–175 BPM; OPEN_QUESTIONS L.37). Re-raise them once the corrections set or the public sets show what real material scores.

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

## Phase 8
- [x] The chat's turn and web-search caps counted from `messages` and recorded tool calls. They now meter into `usage_events` and read back through `usage_summary`, so a direct `POST /api/web/search` is counted too (`web/lib/billing/meter.ts`, `web/lib/chat/limits.ts`); `messages` stays as a floor under the chat-turn count for when the service role is missing. Closes "Usage events behind every quota" in PROPOSALS.
- [ ] Not exercised without an API key: a real model turn through `/api/chat`, the strict tool schemas against the live API, and incremental NDJSON delivery through Vercel. First signed-in run with `ANTHROPIC_API_KEY` set should watch these.
- [ ] Prompt caching is verified against a fake that implements the prefix rule (`web/lib/chat/caching.test.ts`), not against the live API. The first real turn should log `usage.cache_read_input_tokens` on the second request of a session; the procedure is "Confirming the cache live" in `docs/HANDOFF_launch_readiness.md`.
- [ ] The rolling message breakpoint inside the tool loop pays a cache write every round. It wins on turns of three rounds or more and costs about a fifth of a cent on a two-round turn. Worth measuring against real traffic; the knob is one condition in `web/lib/chat/loop.ts`.
- [ ] `CHAT_TURN_SHAPE` in `web/lib/billing/cost.ts` estimates tokens from character counts, because there is no tokenizer in the test environment. Re-baseline it with `messages.count_tokens` on a handful of real turns, and against the `usage` numbers those turns report, once a key is available. Everything downstream (the tier caps, the account page's cost) moves with it.

## Phase 10
- [ ] Backups: point-in-time recovery is a Supabase plan setting, not code; documented in the runbook.
- [ ] Stripe, the DMCA agent registration and the legal pages' company details are placeholders until the owner fills them (RUNBOOK section 6). `node scripts/preflight.mjs` fails until they are.
- [ ] The Pro price is still unset (OPEN_QUESTIONS J.31). The caps in `web/lib/billing/limits.ts` put a fully used Pro account at about $23 a month of our cost; the price has to clear that, or the caps have to come down. Nothing enforces the relationship except `planCeilingUsd` and its test.
- [ ] The free tier's chat caps (8/day, 40/month) are set from cost, not from what a producer needs to evaluate the product. Once there is conversion data, raise them deliberately: every extra turn per free account per month is about 3.3 cents of real money.
- [ ] Unit costs in `web/lib/billing/cost.ts` (Brave per query, Modal GPU and CPU per second, Supabase per GiB-month) are list prices typed from the vendors' pages, not measured from invoices. Reconcile them against the first real bill.
- [ ] Quota enforcement is per request, so two chat turns started in the same instant can both pass the check. At these cap sizes the overrun is one turn; a transactional check needs a counter with a unique constraint or an RPC.
