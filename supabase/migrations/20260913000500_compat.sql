-- Compatibility: "what in my crate works with this?" (docs/HANDOFF_compat.md).
--
-- The coarse filter for the Fits-with panel. It answers the cheap half of the
-- question in the database -- which of the caller's files are even in the right
-- tempo window and the right key family -- so the route only scores a handful of
-- rows instead of the whole library. The exact arithmetic, the confidence and
-- the wording live in analysis/lockedgroove/analysis/compat.py and its web
-- mirror (web/lib/compat/theory.ts); this file follows the same rules and the
-- same constants so the two agree on who is a candidate.
--
-- Shape follows library_filter and similar_files in 20260913000200_search.sql:
-- security invoker so RLS decides what the caller can see, an explicit
-- search_path, effective values (a user_edits correction wins over the
-- prediction, principle 7), and a capped limit.

-- ---------------------------------------------------------------------------
-- key theory: the same five relationships compat.py classifies
-- ---------------------------------------------------------------------------

-- 0-11 for a tonic. The report spells tonics with sharps (CLAUDE.md
-- conventions); flats are accepted because a user edit may carry one.
create or replace function public.pitch_class_index(p_tonic text)
returns integer
language sql
immutable
security invoker
set search_path = public, extensions
as $$
  with parsed as (
    select upper(left(btrim(p_tonic), 1)) as letter,
           lower(btrim(substr(btrim(p_tonic), 2))) as accidental
  ),
  spelled as (
    select case accidental when '' then letter when '#' then letter || '#' when 'b' then letter || 'b' end as name
    from parsed
    where letter between 'A' and 'G'
  )
  select array_position(
           array['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'],
           case name
             when 'Db' then 'C#' when 'Eb' then 'D#' when 'Gb' then 'F#' when 'Ab' then 'G#'
             when 'Bb' then 'A#' when 'Cb' then 'B'  when 'Fb' then 'E'  when 'E#' then 'F'
             when 'B#' then 'C'  else name
           end) - 1
  from spelled;
$$;

-- One of 'same', 'relative', 'dominant', 'subdominant', 'parallel', or null.
-- The fifths require the same mode: G major over C minor is a B natural against
-- a B flat, not a dominant pairing (compat.direct_relationship).
create or replace function public.key_direct_relation(
  p_source_pc integer,
  p_source_mode text,
  p_candidate_pc integer,
  p_candidate_mode text
)
returns text
language sql
immutable
security invoker
set search_path = public, extensions
as $$
  select case
    when p_source_pc is null or p_candidate_pc is null then null
    when p_source_mode not in ('major', 'minor') or p_candidate_mode not in ('major', 'minor') then null
    when p_source_mode = p_candidate_mode then
      case ((p_candidate_pc - p_source_pc) % 12 + 12) % 12
        when 0 then 'same'
        when 7 then 'dominant'
        when 5 then 'subdominant'
        else null
      end
    when ((p_candidate_pc - p_source_pc) % 12 + 12) % 12 = 0 then 'parallel'
    -- the relative minor sits 9 semitones above its major (A minor over C major)
    when p_source_mode = 'major' and p_candidate_mode = 'minor'
         and ((p_candidate_pc - p_source_pc) % 12 + 12) % 12 = 9 then 'relative'
    when p_source_mode = 'minor' and p_candidate_mode = 'major'
         and ((p_candidate_pc - p_source_pc) % 12 + 12) % 12 = 3 then 'relative'
    else null
  end;
$$;

-- compat.RELATIONSHIP_STRENGTH, for the tie-break inside key_match_shift.
create or replace function public.key_relation_strength(p_relation text)
returns double precision
language sql
immutable
security invoker
set search_path = public, extensions
as $$
  select case p_relation
    when 'same' then 1.0
    when 'relative' then 0.9
    when 'dominant' then 0.8
    when 'subdominant' then 0.8
    when 'parallel' then 0.7
    else null
  end::double precision;
$$;

-- The smallest shift of the candidate that lands on one of the five
-- relationships, or null when none is reachable inside p_max_shift
-- (compat.key_relationship). Shift 0 is tried first, so a pair that already
-- works is never pitched; within one shift size the stronger relationship wins
-- and an upward shift beats a downward one.
create or replace function public.key_match_shift(
  p_source_tonic text,
  p_source_mode text,
  p_candidate_tonic text,
  p_candidate_mode text,
  p_max_shift integer default 6
)
returns integer
language plpgsql
immutable
security invoker
set search_path = public, extensions
as $$
declare
  v_source integer := public.pitch_class_index(p_source_tonic);
  v_candidate integer := public.pitch_class_index(p_candidate_tonic);
  v_size integer;
  v_shift integer;
  v_relation text;
  v_strength double precision;
  v_best_shift integer;
  v_best_strength double precision;
begin
  if v_source is null or v_candidate is null then
    return null;
  end if;
  for v_size in 0 .. greatest(coalesce(p_max_shift, 0), 0) loop
    v_best_shift := null;
    v_best_strength := null;
    foreach v_shift in array (case when v_size = 0 then array[0] else array[v_size, -v_size] end) loop
      v_relation := public.key_direct_relation(
        v_source, p_source_mode, ((v_candidate + v_shift) % 12 + 12) % 12, p_candidate_mode);
      if v_relation is not null then
        v_strength := public.key_relation_strength(v_relation);
        if v_best_strength is null
           or v_strength > v_best_strength
           or (v_strength = v_best_strength and v_shift > v_best_shift) then
          v_best_strength := v_strength;
          v_best_shift := v_shift;
        end if;
      end if;
    end loop;
    if v_best_shift is not null then
      return v_best_shift;
    end if;
  end loop;
  return null;
end;
$$;

-- The relationship reached at key_match_shift's shift.
create or replace function public.key_match_relation(
  p_source_tonic text,
  p_source_mode text,
  p_candidate_tonic text,
  p_candidate_mode text,
  p_max_shift integer default 6
)
returns text
language sql
immutable
security invoker
set search_path = public, extensions
as $$
  select public.key_direct_relation(
           public.pitch_class_index(p_source_tonic),
           p_source_mode,
           ((public.pitch_class_index(p_candidate_tonic)
             + public.key_match_shift(p_source_tonic, p_source_mode, p_candidate_tonic,
                                      p_candidate_mode, p_max_shift)) % 12 + 12) % 12,
           p_candidate_mode);
$$;

-- ---------------------------------------------------------------------------
-- tonality: a drum break has no key, whatever its chroma read
-- ---------------------------------------------------------------------------
--
-- The key stage always has a best profile, so a break reads as a key at about
-- 0.37 confidence -- a number about the chroma, not about the music. The rule is
-- combine/align.py's AlignItem.is_tonal, which the layer render already obeys,
-- and web/app/api/layers/vitals.ts mirrors: non-tonal tags, or a stem whose name
-- says drums. compat.is_tonal and web/lib/compat/theory.ts isTonal are the same
-- function; keep the tag list in step.
create or replace function public.file_is_tonal(p_file_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select not (
    exists (
      select 1 from public.files f
      where f.id = p_file_id and f.kind = 'stem' and lower(f.original_filename) like '%drums%'
    )
    or exists (
      select 1 from public.tags t
      where t.file_id = p_file_id
        and lower(btrim(t.tag)) in ('drums', 'drum', 'break', 'percussion', 'hats', 'kick', 'snare', 'beatbox')
    )
  );
$$;

-- ---------------------------------------------------------------------------
-- the effective tempo, indexed: a user's correction wins over the prediction,
-- and the tempo window below is a range over exactly this expression
-- ---------------------------------------------------------------------------

create index if not exists files_effective_bpm_idx on public.files (
  user_id,
  (coalesce((report -> 'user_edits' ->> 'tempo_bpm')::double precision,
            (report -> 'tempo' ->> 'bpm')::double precision))
);

-- ---------------------------------------------------------------------------
-- compatible_files: the coarse candidate set
-- ---------------------------------------------------------------------------
--
-- p_stretch_tolerance  widest stretch still offered, as max(r, 1/r) - 1:
--                      0.06 is transparent, 0.14 usable (compat.USABLE_MAX).
-- p_max_semitones      how far the caller will pitch a file to make it fit.
--                      2 keeps the character of the material (compat.CHARACTER_SHIFT);
--                      6 reaches every key, and 4 is as far as it ever needs to.
-- p_max_octaves        how many halvings or doublings the fold may use. 1 is
--                      half-time and double-time, the moves producers make.
-- p_include_keyless    keyless material (a drum break, or anything tagged non-tonal)
--                      fits anything harmonically; false excludes it when the
--                      caller wants pitched material only.
--
-- Rows with no measured tempo are kept -- nothing was measured, so nothing rules
-- them out -- and sort after the ones that could be measured.
create or replace function public.compatible_files(
  p_file_id uuid,
  p_limit integer default 20,
  p_stretch_tolerance double precision default 0.14,
  p_max_semitones integer default 2,
  p_kind text default null,
  p_max_octaves integer default 1,
  p_include_keyless boolean default true
)
returns table (
  file_id uuid,
  octave_factor double precision,
  folded_bpm double precision,
  stretch_ratio double precision,
  stretch_distance double precision,
  key_relation text,
  semitone_shift integer
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with args as (
    select greatest(coalesce(p_stretch_tolerance, 0.14), 0.0) as tolerance,
           greatest(coalesce(p_max_octaves, 1), 0) as octaves,
           greatest(coalesce(p_max_semitones, 2), 0) as semitones
  ),
  src as (
    select f.id,
           coalesce((f.report -> 'user_edits' ->> 'tempo_bpm')::double precision,
                    (f.report -> 'tempo' ->> 'bpm')::double precision) as bpm,
           case when public.file_is_tonal(f.id)
                then coalesce(f.report -> 'user_edits' -> 'key' ->> 'tonic', f.report -> 'key' ->> 'tonic') end as tonic,
           case when public.file_is_tonal(f.id)
                then coalesce(f.report -> 'user_edits' -> 'key' ->> 'mode', f.report -> 'key' ->> 'mode') end as mode
    from public.files f
    where f.id = p_file_id
      and f.user_id = (select auth.uid())
  ),
  cand as (
    select f.id,
           coalesce((f.report -> 'user_edits' ->> 'tempo_bpm')::double precision,
                    (f.report -> 'tempo' ->> 'bpm')::double precision) as bpm,
           case when public.file_is_tonal(f.id)
                then coalesce(f.report -> 'user_edits' -> 'key' ->> 'tonic', f.report -> 'key' ->> 'tonic') end as tonic,
           case when public.file_is_tonal(f.id)
                then coalesce(f.report -> 'user_edits' -> 'key' ->> 'mode', f.report -> 'key' ->> 'mode') end as mode,
           s.bpm as src_bpm,
           s.tonic as src_tonic,
           s.mode as src_mode,
           a.tolerance,
           a.octaves,
           a.semitones
    from public.files f
      cross join src s
      cross join args a
    where f.user_id = (select auth.uid())
      and f.status = 'ready'
      and f.id <> s.id
      and (p_kind is null or f.kind = p_kind)
      and (p_include_keyless
           or (public.file_is_tonal(f.id)
               and coalesce(f.report -> 'user_edits' -> 'key' ->> 'tonic', f.report -> 'key' ->> 'tonic') is not null))
      -- the widest window any fold could reach, as a range on the indexed
      -- expression; the exact distance is checked below
      and (s.bpm is null
           or coalesce((f.report -> 'user_edits' ->> 'tempo_bpm')::double precision,
                       (f.report -> 'tempo' ->> 'bpm')::double precision) is null
           or coalesce((f.report -> 'user_edits' ->> 'tempo_bpm')::double precision,
                       (f.report -> 'tempo' ->> 'bpm')::double precision)
              between s.bpm / ((2.0 ^ a.octaves) * (1.0 + a.tolerance))
                  and s.bpm * (2.0 ^ a.octaves) * (1.0 + a.tolerance))
  ),
  folded as (
    select c.*,
           case
             when c.bpm is null or c.src_bpm is null or c.bpm <= 0 or c.src_bpm <= 0 then 1.0::double precision
             else (2.0::numeric ^ least(greatest(round(log(2.0::numeric, (c.src_bpm / c.bpm)::numeric)),
                                                 -c.octaves::numeric), c.octaves::numeric))::double precision
           end as factor
    from cand c
  ),
  stretched as (
    select f.*,
           f.bpm * f.factor as folded_bpm,
           case when f.bpm is null or f.src_bpm is null or f.bpm <= 0 then null
                else f.src_bpm / (f.bpm * f.factor) end as ratio
    from folded f
  ),
  matched as (
    select s.*,
           case when s.ratio is null then null
                else greatest(s.ratio, 1.0 / s.ratio) - 1.0 end as distance,
           public.key_match_shift(s.src_tonic, s.src_mode, s.tonic, s.mode, s.semitones) as shift
    from stretched s
  )
  select m.id,
         m.factor,
         m.folded_bpm,
         m.ratio,
         m.distance,
         case when m.src_tonic is null or m.tonic is null then null
              else public.key_match_relation(m.src_tonic, m.src_mode, m.tonic, m.mode, m.semitones) end,
         m.shift
  from matched m
  where (m.distance is null or m.distance <= m.tolerance)
    and (m.src_tonic is null or m.tonic is null or m.shift is not null)
  order by coalesce(m.distance, 1.0) asc, abs(coalesce(m.shift, 0)) asc, m.id asc
  limit least(coalesce(p_limit, 20), 100);
$$;
