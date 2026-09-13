-- The song as rows, not as a blob.
--
-- OPEN_QUESTIONS 38 asks whether a session is a first-class library row with
-- its own tables or a document blob, and assumes tables "because 'what's in
-- bar 17' should be answerable". These are those tables, and the shape is the
-- one the in-memory model already has (web/lib/session/types.ts,
-- web/lib/session/arrangement.ts, web/lib/session/lineage.ts), so persisting a
-- session is an insert rather than a redesign.
--
-- The thing worth getting right here is the last table's `lineage` column.
-- Every region on the timeline knows which record it is, which of that
-- record's bars, which separation made it and what was done to it, and that
-- line survives moving, trimming, splitting and copying. If it lives only in
-- the browser then a reload turns a song back into anonymous blocks of audio,
-- the breakdown stops being honest, and principle 1 stops being enforceable
-- from the database. So the columns a query needs are columns, and the rest is
-- one jsonb.
--
-- The queries these are shaped for:
--
--   what is in bar 17
--     select t.name, r.*
--       from song_regions r join song_tracks t on t.id = r.track_id
--      where r.session_id = $1
--        and r.start_s < $bar_end and r.start_s + r.duration_s > $bar_start
--      order by t.position;
--
--   which records is this song built from, and how were they separated
--     select distinct r.source_file_id,
--            r.lineage ->> 'fileName',
--            r.lineage ->> 'separationModel'
--       from song_regions r where r.session_id = $1;
--
--   every region that came from one record (the breakdown, and a takedown)
--     select * from song_regions where user_id = $1 and source_file_id = $2;
--
-- NOT APPLIED by the agent that wrote it: run it with the Supabase CLI.

-- ---------------------------------------------------------------------------
-- song_sessions: one song
-- ---------------------------------------------------------------------------

create table if not exists public.song_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text,
  -- the session's own grid. Bar 1 is second zero (web/lib/session/time.ts).
  -- Null bpm means the session has no measured tempo and therefore has no
  -- bars; nothing may invent one to fill this in.
  bpm real check (bpm is null or bpm > 0),
  beats_per_bar smallint not null default 4 check (beats_per_bar > 0),
  -- the producer's snap choice, which is a property of how they work and
  -- belongs with the song rather than in a browser preference
  snap text not null default 'bar' check (snap in ('bar', 'beat', 'eighth', 'sixteenth', 'off')),
  loop_start_s double precision,
  loop_end_s double precision,
  master_gain real not null default 1 check (master_gain >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (loop_end_s is null or loop_start_s is null or loop_end_s > loop_start_s)
);

create index if not exists song_sessions_user_idx on public.song_sessions (user_id, updated_at desc);

create trigger song_sessions_set_updated_at
  before update on public.song_sessions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- song_tracks: one lane
-- ---------------------------------------------------------------------------

create table if not exists public.song_tracks (
  id text not null,
  session_id uuid not null references public.song_sessions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- lane order is the producer's and is not audible; it is still theirs to keep
  position integer not null default 0,
  name text not null,
  gain real not null default 1 check (gain >= 0),
  muted boolean not null default false,
  soloed boolean not null default false,
  -- the library file the lane came from, when it came from one
  file_id uuid references public.files (id) on delete set null,
  origin text not null default 'candidate' check (origin in ('candidate', 'audition', 'file', 'render')),
  provenance text,
  created_at timestamptz not null default now(),
  primary key (session_id, id)
);

create index if not exists song_tracks_session_idx on public.song_tracks (session_id, position);
create index if not exists song_tracks_file_idx on public.song_tracks (file_id);

-- ---------------------------------------------------------------------------
-- song_regions: a piece of one record, on one lane, at one place
-- ---------------------------------------------------------------------------

create table if not exists public.song_regions (
  id text not null,
  session_id uuid not null references public.song_sessions (id) on delete cascade,
  track_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,

  -- where it sits on the timeline, in session seconds
  start_s double precision not null check (start_s >= 0),
  duration_s double precision not null check (duration_s > 0),
  -- which second of the source it starts at. A head trim moves start_s and
  -- offset_s together; a tail trim moves only duration_s. Storing both is what
  -- makes that distinction survive a reload.
  offset_s double precision not null default 0 check (offset_s >= 0),
  gain real not null default 1 check (gain >= 0),
  -- 1 is the recording's own speed. Anything else is resampling: pitch moves
  -- with tempo, the way a sampler does.
  rate real not null default 1 check (rate > 0),

  -- the audio itself, as a column because every lineage query starts here
  source_file_id uuid not null references public.files (id) on delete cascade,

  -- What this region actually is (web/lib/session/lineage.ts RegionLineage):
  --   fileName, parentFileId, kind, stem,
  --   separationModel, separationModelLabel,
  --   takeStartS, takeEndS, downbeatS, sourceDurationS,
  --   sourceBpm, sourceBeatsPerBar,
  --   cents, stretch,
  --   candidateId, reason, confidence
  -- The record's own bars are NOT stored: they are derived from offset_s,
  -- duration_s, rate, downbeatS and sourceBpm, so that trimming a region
  -- changes the bars it claims rather than leaving a stale number behind.
  lineage jsonb,

  created_at timestamptz not null default now(),
  primary key (session_id, id),
  foreign key (session_id, track_id) references public.song_tracks (session_id, id) on delete cascade
);

-- "what is in bar 17": every region that overlaps a span, on one song
create index if not exists song_regions_span_idx on public.song_regions (session_id, start_s);
create index if not exists song_regions_track_idx on public.song_regions (session_id, track_id, start_s);
-- "which of my records is this song built from", and the takedown path
create index if not exists song_regions_source_idx on public.song_regions (user_id, source_file_id);
-- containment on the lineage: which songs used a stem from a given separator,
-- which used a particular candidate the rack ranked
create index if not exists song_regions_lineage_gin_idx on public.song_regions using gin (lineage jsonb_path_ops);

comment on column public.song_regions.offset_s is
  'Seconds into the source the region starts. A head trim moves start_s and offset_s together; a tail trim changes only duration_s.';
comment on column public.song_regions.rate is
  'Playback rate. 1 is the recording own speed; anything else resamples, moving pitch with tempo. A render that stretches with pitch held records that in lineage.stretch instead.';
comment on column public.song_regions.lineage is
  'Which record, which separation, which take, which transform. A normal DAW throws this away at import; the breakdown, the corrections table and principle 1 all depend on it.';

-- ---------------------------------------------------------------------------
-- row level security: auth.uid() = user_id on every table, every operation
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['song_sessions', 'song_tracks', 'song_regions']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)',
      t || '_select_own', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)',
      t || '_insert_own', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)',
      t || '_update_own', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = user_id)',
      t || '_delete_own', t);
  end loop;
end;
$$;
