-- Sample-ready loops: make "show me the vocal-free 4 bar loops in this record" a query.
--
-- No new column. The finder writes the per-stem profile and the claims into the
-- existing `loops.components` jsonb, under `components -> 'sample_ready'`:
--
--   {"source":   {"model": "...", "trusted": true, "note": null},
--    "claims":   {"vocal_free": {"value": true, "confidence": 0.95, "why": "...",
--                                "stem": "vocals", "presence": "absent"},
--                 "drums_free": {...}, "drums_only": {...},
--                 "fullness":   {"value": 3, "confidence": 0.95, "of": 4,
--                                "stems_present": [...], "stems_faint": [...]}},
--    "profile":  {"<stem>": {"presence": "absent|faint|present", "mean_db": ...,
--                            "peak_db": ..., "rel_mean_db": ..., "rel_peak_db": ...,
--                            "rel_mix_db": ..., "audible_fraction": ...,
--                            "loudest_at_s": ..., "isolation_db": ...,
--                            "leakage_correlation": ..., "leaks_from": ...}},
--    "caveats":  ["..."],
--    "ranking_factor": 1.0}
--
-- A claim whose `value` is null was withheld (no such stem, or stems from the
-- development stand-in) and must never match a filter: `value = true` is the
-- only thing that means "measured, and yes".
--
-- NOT APPLIED by the agent that wrote it: run it with the Supabase CLI.

-- Containment queries on any claim:
--   where components @> '{"sample_ready":{"claims":{"drums_only":{"value":true}}}}'
create index if not exists loops_components_gin_idx
  on public.loops using gin (components jsonb_path_ops);

-- The query that saves the time, ordered the way it is shown:
--   select * from loops
--    where file_id = $1 and bars = 4
--      and components #>> '{sample_ready,claims,vocal_free,value}' = 'true'
--      and (components #>> '{sample_ready,claims,vocal_free,confidence}')::real >= 0.6
--    order by score desc;
create index if not exists loops_vocal_free_idx
  on public.loops (file_id, bars, score desc)
  where (components #>> '{sample_ready,claims,vocal_free,value}') = 'true';

create index if not exists loops_drums_free_idx
  on public.loops (file_id, bars, score desc)
  where (components #>> '{sample_ready,claims,drums_free,value}') = 'true';

create index if not exists loops_drums_only_idx
  on public.loops (file_id, bars, score desc)
  where (components #>> '{sample_ready,claims,drums_only,value}') = 'true';

comment on index public.loops_components_gin_idx is
  'Containment lookups on components, including sample_ready claims (vocal-free, drums-free, drums-only, fullness).';
