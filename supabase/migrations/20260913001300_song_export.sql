-- The song, out.
--
-- Rendering a multi-minute multitrack arrangement to stems is compute work,
-- so the export is a job kind like every other one (docs/CONTRACTS.md
-- sections 4 and 5): a row, a dispatch, results written back, and
-- `usage_events` metered by the same runner path as the rest. All this
-- migration has to do is let `jobs.kind` say 'export'.
--
-- Nothing else changes:
--
--   * The zip lands at `derived/{user_id}/bundles/{job_id}.zip`, which is
--     already the export-bundle prefix in CONTRACTS section 2, so the storage
--     policies already say exactly the right thing: a user may read
--     `derived/{their id}/` and nothing else. The download route fetches with
--     the caller's own client, so that policy is what decides (principle 6).
--
--   * No `files` row. An export is a derived artefact the producer downloads,
--     not a library entry: it is not audio anybody analyses, searches, layers
--     or chops, and giving it a `files` row would put a zip into every kind
--     filter in the product for no benefit. `files.kind` is untouched.
--
--   * No new usage kind. An export is CPU time, which `usage_events` already
--     has ('cpu_seconds'), and the runner already writes one row per finished
--     job. The check constraint there is untouched.
--
--   * No table for the song itself. `20260913001000_song_arrangement.sql`
--     holds that shape and is likewise not applied; until it is, the
--     arrangement travels in `jobs.params.song`, which is why the export can
--     ship before persistence does. When those tables land, the route grows a
--     `{ session_id }` form that reads the same shape out of them and nothing
--     in this migration changes.
--
-- Written, NOT applied.

alter table public.jobs drop constraint if exists jobs_kind_check;

alter table public.jobs
  add constraint jobs_kind_check
  check (kind in ('analyze', 'stems', 'chop', 'midi', 'embed', 'render_loop', 'layer',
                  'revoice', 'breakdown', 'compare', 'beatbox_train', 'beatbox_transcribe',
                  'export'));

-- The export panel asks "have I already exported this song?" and the account
-- page lists a user's recent exports. Both are `kind = 'export'` for one user,
-- newest first; `jobs_user_status_idx` is on (user_id, status, created_at) and
-- does not serve that. This one does, and is small: export rows are rare.
create index if not exists jobs_user_export_idx
  on public.jobs (user_id, created_at desc)
  where kind = 'export';
