-- Search (BUILD_PACKET section 12): vector similarity over CLAP embeddings with the
-- structured filters the hybrid parser produces, plus a richer library_filter.

create or replace function public.search_embeddings(
  p_query extensions.vector,
  p_model text,
  p_limit integer default 20,
  p_kind text default null,
  p_bpm_min double precision default null,
  p_bpm_max double precision default null,
  p_tonic text default null,
  p_mode text default null,
  p_has_drums boolean default null,
  p_is_loop_based boolean default null,
  p_exclude_file_id uuid default null
)
returns table (file_id uuid, similarity double precision)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select e.file_id, 1 - (e.vector <=> p_query) as similarity
  from public.embeddings e
  join public.files f on f.id = e.file_id
  where e.user_id = (select auth.uid())
    and e.model = p_model
    and f.status = 'ready'
    and (p_kind is null or f.kind = p_kind)
    and (p_exclude_file_id is null or f.id <> p_exclude_file_id)
    and (p_bpm_min is null or coalesce((f.report -> 'user_edits' ->> 'tempo_bpm')::double precision,
                                       (f.report -> 'tempo' ->> 'bpm')::double precision) >= p_bpm_min)
    and (p_bpm_max is null or coalesce((f.report -> 'user_edits' ->> 'tempo_bpm')::double precision,
                                       (f.report -> 'tempo' ->> 'bpm')::double precision) <= p_bpm_max)
    and (p_tonic is null or coalesce(f.report -> 'user_edits' -> 'key' ->> 'tonic', f.report -> 'key' ->> 'tonic') = p_tonic)
    and (p_mode is null or coalesce(f.report -> 'user_edits' -> 'key' ->> 'mode', f.report -> 'key' ->> 'mode') = p_mode)
    and (p_is_loop_based is null or (f.report -> 'sample_use' ->> 'is_loop_based')::boolean = p_is_loop_based)
    and (p_has_drums is null or p_has_drums = exists (
          select 1 from public.tags t
          where t.file_id = f.id and t.tag in ('drums', 'drum break', 'drum machine', 'kick', 'snare', 'hi-hat', 'percussion loop')))
  order by e.vector <=> p_query
  limit least(coalesce(p_limit, 20), 100);
$$;

create or replace function public.similar_files(
  p_file_id uuid,
  p_limit integer default 20
)
returns table (file_id uuid, similarity double precision)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select s.file_id, s.similarity
  from public.embeddings src,
       lateral public.search_embeddings(src.vector, src.model, p_limit, null, null, null, null, null, null, null, p_file_id) s
  where src.file_id = p_file_id
    and src.user_id = (select auth.uid())
  order by src.created_at desc, s.similarity desc
  limit least(coalesce(p_limit, 20), 100);
$$;

drop function if exists public.library_filter(double precision, double precision, text, text, text, integer);

create or replace function public.library_filter(
  p_bpm_min double precision default null,
  p_bpm_max double precision default null,
  p_tonic text default null,
  p_mode text default null,
  p_kind text default null,
  p_limit integer default 50,
  p_has_drums boolean default null,
  p_is_loop_based boolean default null,
  p_tags text[] default null,
  p_text text default null
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
    and (p_bpm_min is null or coalesce((f.report -> 'user_edits' ->> 'tempo_bpm')::double precision,
                                       (f.report -> 'tempo' ->> 'bpm')::double precision) >= p_bpm_min)
    and (p_bpm_max is null or coalesce((f.report -> 'user_edits' ->> 'tempo_bpm')::double precision,
                                       (f.report -> 'tempo' ->> 'bpm')::double precision) <= p_bpm_max)
    and (p_tonic is null or coalesce(f.report -> 'user_edits' -> 'key' ->> 'tonic', f.report -> 'key' ->> 'tonic') = p_tonic)
    and (p_mode is null or coalesce(f.report -> 'user_edits' -> 'key' ->> 'mode', f.report -> 'key' ->> 'mode') = p_mode)
    and (p_is_loop_based is null or (f.report -> 'sample_use' ->> 'is_loop_based')::boolean = p_is_loop_based)
    and (p_has_drums is null or p_has_drums = exists (
          select 1 from public.tags t
          where t.file_id = f.id and t.tag in ('drums', 'drum break', 'drum machine', 'kick', 'snare', 'hi-hat', 'percussion loop')))
    and (p_tags is null or exists (
          select 1 from public.tags t where t.file_id = f.id and t.tag = any (p_tags)))
    and (p_text is null or f.original_filename ilike '%' || p_text || '%'
         or f.title ilike '%' || p_text || '%' or f.artist ilike '%' || p_text || '%')
  order by f.created_at desc
  limit least(coalesce(p_limit, 50), 200);
$$;
