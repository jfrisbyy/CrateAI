-- lockedgroove / CrateAI: initial schema.
--
-- Principles enforced here:
--   6. User audio is private, always: every table carries user_id, RLS on
--      everything, a private storage bucket with per-user prefixes.
--   7. User corrections are ground truth: the corrections table logs
--      prediction and fix; nothing else reads it.
--
-- Service role bypasses RLS only from the compute result writers and admin
-- scripts (BUILD_PACKET section 3).

create extension if not exists pgcrypto;
create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- files: every library entry (originals and everything derived)
-- ---------------------------------------------------------------------------

create table public.files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  sha256 text not null,
  original_filename text not null,
  storage_path text not null,
  size_bytes bigint,
  duration_s double precision,
  sample_rate integer,
  channels integer,
  format text,
  kind text not null default 'original'
    check (kind in ('original', 'stem', 'chop', 'loop_render', 'layer_render', 'revoice_render')),
  parent_file_id uuid references public.files (id) on delete set null,
  status text not null default 'uploading'
    check (status in ('uploading', 'queued', 'analyzing', 'ready', 'failed')),
  analysis_version integer not null default 0,
  report jsonb,
  peaks jsonb,
  title text,
  artist text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, sha256)
);

create index files_user_created_idx on public.files (user_id, created_at desc);
create index files_user_kind_idx on public.files (user_id, kind);
create index files_parent_idx on public.files (parent_file_id);
create index files_report_bpm_idx on public.files (user_id, ((report -> 'tempo' ->> 'bpm')::numeric));

create trigger files_set_updated_at
  before update on public.files
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- jobs: one row per compute invocation
-- ---------------------------------------------------------------------------

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  file_id uuid references public.files (id) on delete cascade,
  kind text not null
    check (kind in ('analyze', 'stems', 'chop', 'midi', 'embed', 'render_loop', 'layer',
                    'revoice', 'breakdown', 'compare', 'beatbox_train', 'beatbox_transcribe')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'failed')),
  params jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  modal_call_id text,
  progress real,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index jobs_user_status_idx on public.jobs (user_id, status, created_at desc);
create index jobs_file_idx on public.jobs (file_id);

-- ---------------------------------------------------------------------------
-- loops, stems, chops, midi
-- ---------------------------------------------------------------------------

create table public.loops (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  file_id uuid not null references public.files (id) on delete cascade,
  start_s double precision not null,
  end_s double precision not null,
  bars integer,
  score real,
  origin text not null default 'finder' check (origin in ('finder', 'user', 'chat')),
  components jsonb,
  name text,
  render_file_id uuid references public.files (id) on delete set null,
  created_at timestamptz not null default now(),
  check (end_s > start_s)
);

create index loops_file_idx on public.loops (file_id);

create table public.stems (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  file_id uuid not null references public.files (id) on delete cascade,
  stem text not null,
  model text not null,
  stem_file_id uuid not null references public.files (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (file_id, model, stem)
);

create index stems_file_idx on public.stems (file_id);

create table public.chops (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source_file_id uuid not null references public.files (id) on delete cascade,
  start_s double precision not null,
  end_s double precision not null,
  index integer not null,
  name text,
  chop_file_id uuid references public.files (id) on delete set null,
  created_at timestamptz not null default now()
);

create index chops_source_idx on public.chops (source_file_id, index);

create table public.midi (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source_file_id uuid references public.files (id) on delete cascade,
  kind text not null check (kind in ('melody', 'drums', 'chords', 'beatbox', 'groove')),
  storage_path text not null,
  notes jsonb,
  created_at timestamptz not null default now()
);

create index midi_source_idx on public.midi (source_file_id);

-- ---------------------------------------------------------------------------
-- layers (combine), revoices
-- ---------------------------------------------------------------------------

create table public.layers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text,
  tempo_bpm double precision,
  key jsonb,
  render_file_id uuid references public.files (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger layers_set_updated_at
  before update on public.layers
  for each row execute function public.set_updated_at();

create table public.layer_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  layer_id uuid not null references public.layers (id) on delete cascade,
  file_id uuid not null references public.files (id) on delete cascade,
  offset_s double precision not null default 0,
  gain_db double precision not null default 0,
  stretch_ratio double precision not null default 1,
  pitch_semitones double precision not null default 0,
  muted boolean not null default false,
  stretch_mode text not null default 'transient',
  filter jsonb,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create index layer_items_layer_idx on public.layer_items (layer_id, position);

create table public.revoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source_file_id uuid not null references public.files (id) on delete cascade,
  instrument text not null,
  path text not null check (path in ('symbolic', 'neural')),
  midi_id uuid references public.midi (id) on delete set null,
  render_file_id uuid references public.files (id) on delete set null,
  params jsonb,
  created_at timestamptz not null default now()
);

create index revoices_source_idx on public.revoices (source_file_id);

-- ---------------------------------------------------------------------------
-- breakdowns, comparisons
-- ---------------------------------------------------------------------------

create table public.breakdowns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  file_id uuid not null references public.files (id) on delete cascade,
  version integer not null default 1,
  content jsonb not null,
  web_context jsonb,
  narration text,
  created_at timestamptz not null default now(),
  unique (file_id, version)
);

create table public.comparisons (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  file_a_id uuid not null references public.files (id) on delete cascade,
  file_b_id uuid not null references public.files (id) on delete cascade,
  content jsonb not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- embeddings (CLAP, 512-d), tags, corrections
-- ---------------------------------------------------------------------------

create table public.embeddings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  file_id uuid not null references public.files (id) on delete cascade,
  model text not null,
  vector vector(512) not null,
  created_at timestamptz not null default now(),
  unique (file_id, model)
);

create index embeddings_vector_hnsw_idx on public.embeddings
  using hnsw (vector vector_cosine_ops);
create index embeddings_user_idx on public.embeddings (user_id);

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  file_id uuid not null references public.files (id) on delete cascade,
  tag text not null,
  source text not null default 'model' check (source in ('model', 'user')),
  confidence real not null default 1 check (confidence >= 0 and confidence <= 1),
  created_at timestamptz not null default now(),
  unique (file_id, tag, source)
);

create index tags_user_tag_idx on public.tags (user_id, tag);

create table public.corrections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  file_id uuid not null references public.files (id) on delete cascade,
  field text not null,
  predicted jsonb,
  corrected jsonb,
  created_at timestamptz not null default now()
);

create index corrections_user_field_idx on public.corrections (user_id, field, created_at desc);

-- ---------------------------------------------------------------------------
-- conversations, messages
-- ---------------------------------------------------------------------------

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text,
  file_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool')),
  content jsonb not null,
  tool_calls jsonb,
  citations jsonb,
  created_at timestamptz not null default now()
);

create index messages_conversation_idx on public.messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- beatbox profiles (per-user classifier)
-- ---------------------------------------------------------------------------

create table public.beatbox_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  model_path text not null,
  classes jsonb not null,
  sample_count integer not null default 0,
  cv_accuracy real,
  enabled boolean not null default false,
  trained_at timestamptz not null default now(),
  unique (user_id)
);

-- ---------------------------------------------------------------------------
-- row level security: auth.uid() = user_id on every table, every operation
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'files', 'jobs', 'loops', 'stems', 'chops', 'midi', 'layers', 'layer_items', 'revoices',
    'breakdowns', 'comparisons', 'embeddings', 'tags', 'corrections', 'conversations',
    'messages', 'beatbox_profiles'
  ]
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

-- ---------------------------------------------------------------------------
-- realtime: clients subscribe to their own files and jobs rows
-- ---------------------------------------------------------------------------

alter table public.files replica identity full;
alter table public.jobs replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.files, public.jobs;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- storage: one private bucket, per-user prefixes
--   library/{user_id}/{sha256[:2]}/{sha256}.{ext}   uploaded by the user (tus)
--   derived/{user_id}/{file_id}/...                 written by compute (service role)
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit)
values ('audio', 'audio', false, 2147483648)
on conflict (id) do nothing;

create policy "audio_select_own" on storage.objects
  for select to authenticated
  using (bucket_id = 'audio' and (storage.foldername(name))[2] = (select auth.uid())::text);

create policy "audio_insert_own_library" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'audio'
    and (storage.foldername(name))[1] = 'library'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

create policy "audio_update_own_library" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'audio'
    and (storage.foldername(name))[1] = 'library'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

create policy "audio_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'audio' and (storage.foldername(name))[2] = (select auth.uid())::text);

-- ---------------------------------------------------------------------------
-- rpc: library search over report fields (structured filters; vector search
-- is added in the search migration)
-- ---------------------------------------------------------------------------

create or replace function public.library_filter(
  p_bpm_min double precision default null,
  p_bpm_max double precision default null,
  p_tonic text default null,
  p_mode text default null,
  p_kind text default null,
  p_limit integer default 50
)
returns setof public.files
language sql
stable
security invoker
set search_path = public
as $$
  select f.*
  from public.files f
  where f.user_id = (select auth.uid())
    and f.status = 'ready'
    and (p_kind is null or f.kind = p_kind)
    and (p_bpm_min is null or (f.report -> 'tempo' ->> 'bpm')::double precision >= p_bpm_min)
    and (p_bpm_max is null or (f.report -> 'tempo' ->> 'bpm')::double precision <= p_bpm_max)
    and (p_tonic is null or coalesce(f.report -> 'user_edits' -> 'key' ->> 'tonic', f.report -> 'key' ->> 'tonic') = p_tonic)
    and (p_mode is null or coalesce(f.report -> 'user_edits' -> 'key' ->> 'mode', f.report -> 'key' ->> 'mode') = p_mode)
  order by f.created_at desc
  limit least(coalesce(p_limit, 50), 200);
$$;
