-- Corrective processing, stored with the track it belongs to.
--
-- PRODUCT_DIRECTION ("Also in scope — corrective processing") puts per-track
-- EQ, filters, gain staging and tuning in scope, and a master bus that can be
-- levelled and gently limited. The rule that decides where those live is that
-- processing is a property of the track: a lane that came back dull and was
-- opened up with a 3 dB shelf is not the same lane without it, and a reload
-- that drops the shelf turns the producer's decision into something they have
-- to remember and redo.
--
-- So this is two jsonb columns on tables the arrangement migration
-- (20260913001000_song_arrangement.sql) already defines, not new tables. The
-- reasons for a blob rather than columns here, where the arrangement got real
-- columns:
--
--   Nothing queries inside a chain. "What is in bar 17" is a question about
--   regions and is answered by columns; "what EQ is on the horns" is only ever
--   asked about one lane you already have in hand.
--
--   A chain is a fixed, small shape (web/lib/processing/types.ts): seven named
--   slots, a trim, a tune and a bypass. `web/lib/processing/persist.ts` writes
--   it with a `version` and reads it back forgivingly — missing fields come
--   from the default chain, numbers out of range are clamped to what the
--   controls can actually do, and a blob that is not an object at all loads as
--   no processing rather than throwing. A song that will not open because of
--   an EQ would be worse than a song that opens flat.
--
--   It stays derived-free. The curve is computed from these numbers at read
--   time (web/lib/processing/eq.ts), exactly as it is computed for the audio,
--   so there is no stored response to go stale.
--
-- What is deliberately NOT stored: anything about the audio itself. Processing
-- is never destructive — the samples are untouched and the chain is a graph on
-- top of them — so there is no rendered file, no cached analysis of a processed
-- lane, and taking the chain off is a delete of one column's contents.
--
-- The shape of `processing` (web/lib/processing/persist.ts, StoredProcessing):
--
--   {
--     "version": 1,
--     "bypassed": false,
--     "trimDb": -3,
--     "tuneCents": -18,
--     "bands": [
--       {"id": "hp",  "frequency": 60,   "gainDb": 0,  "q": 0.707, "enabled": true},
--       {"id": "ls",  "frequency": 120,  "gainDb": 0,  "q": 0.707, "enabled": false},
--       {"id": "lo",  "frequency": 250,  "gainDb": -4, "q": 1.2,   "enabled": true},
--       {"id": "mid", "frequency": 900,  "gainDb": 0,  "q": 1.1,   "enabled": false},
--       {"id": "hi",  "frequency": 3000, "gainDb": 0,  "q": 1.1,   "enabled": false},
--       {"id": "hs",  "frequency": 8000, "gainDb": 3,  "q": 0.707, "enabled": true},
--       {"id": "lp",  "frequency": 12000,"gainDb": 0,  "q": 0.707, "enabled": false}
--     ]
--   }
--
-- A slot's filter shape is not stored: its id decides it (BAND_KINDS), so a
-- blob claiming `hp` is a peaking filter is read back as the high-pass it is.
--
-- The shape of `master_processing` (StoredMaster):
--
--   {"version": 1, "bypassed": false,
--    "limiter": {"enabled": true, "ceilingDb": -1, "releaseMs": 120}}
--
-- There is no makeup gain in that object and there is none on the bus. The
-- master can only ever make the session quieter, which is the difference
-- between a safety net and a mastering chain, and mastering is the far side of
-- the line this feature is inside.
--
-- The queries these are shaped for:
--
--   what is on the horns
--     select name, processing from song_tracks
--      where session_id = $1 and id = $2;
--
--   which lanes in this song have been corrected at all
--     select id, name, processing from song_tracks
--      where session_id = $1
--        and processing is not null
--        and processing -> 'bands' @> '[{"enabled": true}]';
--
-- RLS: nothing new. Both columns sit on tables that already carry
-- `auth.uid() = user_id` on every operation.
--
-- DEPENDS ON 20260913001000_song_arrangement.sql, which creates the tables.
--
-- This file originally used `alter table if exists`, so that running it before
-- that migration was a no-op rather than a failure. The seams pass reversed
-- that: a silent no-op means `web/lib/processing/persist.ts` writes a chain to
-- a column that is not there, the producer's EQ disappears on reload, and
-- nothing anywhere says why. A missing dependency should be loud, once, at
-- apply time. The guard below names the file to run first.
--
-- NOT APPLIED by the agent that wrote it: run it with the Supabase CLI.

do $$
begin
  if to_regclass('public.song_tracks') is null or to_regclass('public.song_sessions') is null then
    raise exception using
      errcode = 'undefined_table',
      message = 'song_tracks / song_sessions do not exist',
      hint = 'apply supabase/migrations/20260913001000_song_arrangement.sql first; per-track processing is two columns on the tables it creates';
  end if;
end;
$$;

alter table public.song_tracks
  add column if not exists processing jsonb;

comment on column public.song_tracks.processing is
  'Corrective processing for this lane (web/lib/processing/persist.ts StoredProcessing): seven EQ slots, an input trim in dB, a tune in cents, and whether the chain is bypassed. Null means the lane has no chain at all, which is not the same as a chain that is doing nothing. Never affects the source audio.';

alter table public.song_sessions
  add column if not exists master_processing jsonb;

comment on column public.song_sessions.master_processing is
  'The master bus (web/lib/processing/persist.ts StoredMaster): a gentle limiter with a ceiling and a release, and whether the bus is bypassed. The bus level is master_gain on this same row. There is no makeup gain, by design: the bus can only make the session quieter.';

-- Lanes that have been corrected at all. Partial, because most lanes never get
-- a chain and the index should not carry them.
create index if not exists song_tracks_processed_idx
  on public.song_tracks (session_id)
  where processing is not null;
