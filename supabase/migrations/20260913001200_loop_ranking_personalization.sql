-- Loop ranking that learns from the producer's own corrections (principle 7).
--
-- The corrections table has been written faithfully since the first migration
-- and read by nothing but the accuracy harness. This migration is the read
-- side for loop ranking: a switch the producer controls, an index that makes
-- the read cheap enough to run inside a job, and the payload shapes the loop
-- correction rows carry so the reader and the writer agree in writing.
--
-- NOT APPLIED. Written for review; apply with the Supabase CLI when the web
-- side that writes `loop_edges` / `loop_bars` / `loop_pick` lands.
--
-- Nothing here widens access. `corrections` already carries RLS with
-- `auth.uid() = user_id` on select, insert, update and delete (init migration),
-- and the compute side reads it with the service role for exactly one
-- `user_id` -- the owner of the file being ranked. See
-- `analysis/lockedgroove/learn/loop_prefs.py` and `docs/HANDOFF_ranking.md`.

-- ---------------------------------------------------------------------------
-- the switch: a producer can see what their corrections changed, and stop it
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists loop_personalization boolean not null default true;

comment on column public.profiles.loop_personalization is
  'Whether this account''s own loop corrections adjust its loop ranking. On by default, because a '
  'tool that does not get better as you use it is the thing we are not building; off is one click '
  'and takes effect on the next loop search. Off means the measured ranking alone, which is also '
  'exactly what a brand new account gets.';

-- ---------------------------------------------------------------------------
-- the read path: one account, the loop fields, newest first
-- ---------------------------------------------------------------------------

-- `corrections_user_field_idx (user_id, field, created_at desc)` already serves
-- a single-field lookup. The reader asks for three fields at once, inside a
-- job, on every loop search; a partial index over just the loop rows keeps that
-- to one small scan however large the rest of the table gets.
create index if not exists corrections_user_loop_idx
  on public.corrections (user_id, created_at desc)
  where field in ('loop_edges', 'loop_bars', 'loop_pick');

comment on table public.corrections is
  'Principle 7: every edit to a predicted value, with the prediction beside the fix. Per-user and '
  'never crossed: the accuracy harness reads one account with the owner''s consent, and the loop '
  'ranker reads one account -- its own -- to adjust that account''s ranking. Nothing else reads it.';

comment on column public.corrections.field is
  'What was corrected. Report fields: tempo_bpm, downbeat_phase, first_downbeat_s, key, meter, '
  'section_labels (predicted/corrected are the values themselves). Loop ranking fields, read back '
  'by lockedgroove.learn.loop_prefs: '
  'loop_edges  - a loop''s edges were dragged; predicted and corrected are '
  '{"start_s","end_s","bars"?} for the offered span and the kept one. '
  'loop_bars   - the bar count was set outright; predicted and corrected are the counts, or the '
  'same span shape. '
  'loop_pick   - a candidate was taken over the one ranked first; predicted is the top row and '
  'corrected the chosen row, each {"bars","rank"?,"components"?} where components is the finder''s '
  'scored terms for that row. '
  'A row that does not carry what a signal needs is skipped by the reader, never guessed at.';
