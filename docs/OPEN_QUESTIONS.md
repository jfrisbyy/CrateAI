# OPEN_QUESTIONS.md

Clarifying questions for the owner, each with the assumption the build is
proceeding under until answered. Answer inline (or in chat) and the
assumption gets replaced. Numbered so they can be referenced from PRs.

## A. Name, repo, hosting

1. **Product name.** ~~The repo is `CrateAI`~~ **Answered 2026-09-13: the
   product is Cratebox AI.** The UI, domain and copy say Cratebox; the repo
   stays `CrateAI` and the Python package stays `lockedgroove` until a
   mechanical rename is worth the churn. See `docs/PRODUCT_DIRECTION.md`.
2. **Repository.** The build lives in `jfrisbyy/CrateAI` (was empty). The
   seed commit on `main` holds only your two documents and a `.gitignore`;
   all work is on branch `claude/intelligent-sagan-l0sp03`. `CadenceIOS` was
   left untouched. *Assumption:* you'll open a PR from that branch when you
   want to review; say if you'd rather I push straight to `main`.
3. **Supabase project.** `CrateAI` (`ufmpwtjtyzmfucjyuhqo`, us-east-2) was
   created and the initial migration applied to it. *Assumption:* this is
   the only environment for now (no staging); a second project can take the
   same migrations later.
4. **Modal.** Do you have a Modal workspace? Deploying `analysis/lockedgroove/modal_app.py`
   needs `modal token new` and a secret named `lockedgroove` (see
   `docs/CONTRACTS.md`). *Assumption:* GPU class `A10G` for stem separation
   and CLAP, CPU for everything else; the local runner (`lockedgroove-server`)
   covers development without Modal.
5. **Vercel.** *Assumption:* the `web/` directory is the Vercel project root,
   env vars per `docs/CONTRACTS.md`.
6. **Auth providers.** *Assumption:* email + password and magic link via
   Supabase Auth to start; Google OAuth is a one-line addition once you've
   set up the provider in the dashboard.

## B. Scope and priority

7. **Phase order.** The packet goes 0→10 with the breakdown at Phase 4. It's
   also "the feature this platform should be known for." *Assumption:* the
   packet order stands, but the breakdown's analysis stages are being built
   from the start so Phase 4 is composition, not research.
8. **Target material.** Mostly loop-based hip-hop and soul flips, or also
   house/techno, trap at half-time, live-band recordings? This sets the tempo
   prior (half/double disambiguation), the 4/4 assumption, and which public
   datasets matter most. *Assumption:* hip-hop first; tempo prior centered at
   ~95 BPM with a 60–180 window; alternates always shown.
9. **File limits.** Whole albums and 60-minute DJ mixes make structure
   analysis expensive and less meaningful. *Assumption:* analysis runs on
   files up to 20 minutes; longer files upload, get vitals (tempo, key,
   loudness) from the first 20 minutes, and show a note. Upload cap 2 GB.
10. **Formats.** *Assumption:* WAV, AIFF, FLAC, MP3, M4A/AAC, OGG. Decoding
    via libsndfile + ffmpeg in the compute image; the browser only needs to
    hash and upload.
11. **Users at launch.** Just you, a few producers, or open signup? Decides
    how early rate limits and quotas (Phase 10) matter. *Assumption:* you plus
    invited testers; open signup waits for Phase 10.
12. **Five acceptance records.** Section 11's acceptance needs five records
    you know well. I can't supply copyrighted audio; you upload them in your
    account and tell me what you know about each (BPM, key, how the drums
    were made, what it samples) so I can check the breakdown against it.

## C. Analysis behaviour

13. **Key display.** Sharps internally per CLAUDE.md. Producers say "Bb" and
    "Eb", not "A#" and "D#". *Assumption:* the UI shows the conventional
    spelling for the mode (F minor, Bb major, C# minor, Db major) and the
    other enharmonic on hover; the report stays sharps.
14. **Tempo prior.** librosa's default prior is 120 BPM, which favors
    double-time on boom-bap. *Assumption:* prior at 95 BPM (see B.8); the
    alternates carry half and double; the harness reports octave-tolerant
    accuracy separately, as the packet specifies.
15. **Meter.** 4/4 assumed with per-file override. *Assumption:* the override
    accepts 3/4, 6/8, 5/4, 7/8; downbeats regroup accordingly; meter
    detection stays a proposal.
16. **Confidence thresholds for automatic behaviour.** Loop candidates use
    downbeats only when downbeat confidence ≥ 0.5, otherwise beats.
    *Assumption:* 0.5, exposed as a constant.
17. **Stem model default.** `htdemucs_ft` gives drums, bass, vocals, other.
    *Assumption:* that's the default; `htdemucs_6s` (adds guitar, piano) and
    BS-RoFormer selectable in the Stems tab and by the chat tool's `model`
    argument.

## D. Loops

18. **Export naming.** `{stem}_{bpm}bpm_{key}_{bars}bar.wav`. *Assumption:*
    `{stem}` is the original filename without extension, followed by the
    stem type when the loop came from a stem (`song_drums_90bpm_Fm_4bar.wav`).
19. **Bit depth.** *Assumption:* 24-bit WAV at the source sample rate only;
    16-bit is a one-line addition if you want it.
20. **Crossfade and snapping defaults.** 12 ms equal-power crossfade,
    zero-crossing snap within ±2 ms. *Assumption:* as specified; both
    adjustable in the Loops tab and remembered per loop.

## E. Chat and language

21. **Model per task.** *Assumption:* `claude-opus-5` with adaptive thinking
    for every call today: chat turns (`CHAT_MODEL`), the search query parser
    (`QUERY_PARSER_MODEL`, both in `web/lib/anthropic/models.ts`) and breakdown
    narration (`NARRATION_MODEL` in `web/lib/anthropic/narrate.ts`). Each is
    one constant; the parser and chat can move to `claude-sonnet-5` for cost
    once you have seen the quality on your own material.
22. **Conversation scope.** Per-file threads or one global chat with files
    "in context"? *Assumption:* global conversations; files are attached to a
    conversation by opening them or naming them, and the system prompt embeds
    the effective reports of the attached files.
23. **Batch operations.** "Separate stems on everything in this folder" can
    cost real GPU money. *Assumption:* batch calls over 5 files ask the user to
    confirm with an estimate before queueing.

## F. Web information

24. **Search provider.** Brave or Tavily? *Assumption:* Brave (cheaper per
    query, simpler terms); the provider is behind one interface so switching
    is a config change.
25. **Robots and terms.** *Assumption:* fetch respects robots.txt and skips
    disallowed pages, saying so in chat; results are cached by query for 24 h
    as the packet specifies.

## G. Search

26. **CLAP checkpoint.** LAION's general `clap-htsat-unfused` or the
    music-tuned `music_audioset_epoch_15_esc_90.14`. Both are 512-d.
    *Assumption:* the music checkpoint; it's named in one place.

## H. Combine and re-voice

27. **Time-stretch engine and licensing.** Rubber Band is GPL (a commercial
    license is required for a hosted product); signalsmith-stretch is MIT.
    *Assumption:* signalsmith-stretch via its Python bindings, with a
    high-quality phase-vocoder fallback from librosa when the binding isn't
    available in the image. Say if you already hold a Rubber Band license.
28. **Instrument set for symbolic re-voice.** *Assumption:* GeneralUser GS or
    FluidR3 (GM soundfonts, permissive) for breadth, plus a few better
    single instruments (VSCO 2 CE, CC0) where quality matters: piano, Rhodes,
    strings, brass, upright bass, guitars.
29. **Neural re-voice appetite.** DDSP/RAVE-class models are uneven in
    quality. *Assumption:* evaluated in Phase 7 and shipped only if it
    clearly beats the symbolic path on monophonic sources; otherwise deferred
    with the reason written in PROPOSALS.

## I. Beatbox

30. **Classes.** Kick, snare, hat only, or also open hat, clap, rim, tom?
    *Assumption:* kick/snare/hat at enrollment, with the class list stored
    per profile so more can be added without a migration.

## J. Billing and legal

31. **Free tier and pricing.** Packet numbers: 2 GB, 5 stem jobs/month, 50
    chat turns/day, 20 web searches/day. *Assumption:* used as constants; one
    paid tier as a placeholder until you set prices.
32. **Legal entity and DMCA agent.** ToS, privacy, and the DMCA page need the
    entity name and the agent's contact. *Assumption:* placeholders marked
    `TODO(owner)`.

## K. Design

33. **Visual direction.** Packet says dense, quiet, dark, one accent,
    monospace numerals. *Assumption:* graphite background, a warm amber
    accent (the color of a lit pad), Public Sans for interface text and
    JetBrains Mono for every numeral. Tell me if the accent should be
    something else, or if you have a mark or wordmark for CrateAI.
34. **Keyboard map.** Space play/pause, `[` `]` loop edges, 1–8 and Q–I
    pads, `,` `.` nudge, `L` new loop at cursor, `D` set downbeat.
    *Assumption:* as listed; documented in the app under `?`.

## L. Data and evaluation

35. **Public datasets.** GiantSteps audio is fetched from Beatport previews by
    the dataset's own script, and Ballroom from the ISMIR 2004 mirror. This is
    developer tooling under `scripts/`, never an app code path, so principle 3
    is intact. *Assumption:* acceptable; the datasets live in `data/` which is
    gitignored.
36. **Corrections as evaluation data.** Corrections are per-user and used
    only for the harness. *Assumption:* the harness reads them with the
    service role in CI against your own account only, and never for other
    users without a written opt-in.
38. **Harmonix audio.** The Harmonix Set gives 179 hip-hop, R&B and funk
    tracks with human beat, downbeat, segment and tempo annotations, but
    distributes no audio. *Assumption:* you hold many of these records
    already and will drop the ones you have into `data/harmonix/audio/`;
    the loader scores whatever it finds, so even 30 of the 179 is a far
    better read on real accuracy than the synthetic set gives. The track
    list with artist and title is `scripts/datasets/harmonix.json`.
37. **The exact-tempo gate on the synthetic set.** The synthetic tempos are
    uniform over 65–175 BPM with hats on every eighth, so the exact octave
    is a convention; the hip-hop prior (question 14) halves the items above
    ~120 and doubles the ones below ~75 by design, and the set scores 0.56
    exact against 1.00 octave-tolerant. Four octave rules were compared
    (autocorrelation with the prior, and three that mix in the Fourier
    tempogram); the current one is the best of them on this set, the others
    double the slow items. *Assumption:* the synthetic `bpm_exact` gate is
    0.50 (`scripts/gates.json`, with the reason in its notes) and the packet's
    0.80 stays for the public sets and the corrections set. If your material
    is not hip-hop first, say so and the prior moves (one constant,
    `PRIOR_BPM`), or becomes a per-account preference (PROPOSALS).
37. *(see the structure gate question above)*
38. **Session persistence.** Is a song a first-class library row with its own
    tables (tracks, regions, edits), or a document blob? *Assumption:* tables,
    so the chat can answer "what is in bar 17". See PRODUCT_DIRECTION.
39. **How much of the song does the chat see?** *Assumption:* a compact
    summary of tracks and regions in the prompt, with a tool to read any
    region in detail.
40. **Export target.** *Assumption:* stems plus a tempo map and a readme
    first; native DAW session formats on request.
