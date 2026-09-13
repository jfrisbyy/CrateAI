-- Onboarding state, per account instead of per device.
--
-- NOT APPLIED. Nothing in the web app reads or writes these columns yet: the
-- first run remembers the same five facts in `localStorage`
-- (web/lib/onboarding/memory.ts), which is enough for one producer on one
-- machine and wrong for a producer who signs in on the studio desktop after
-- starting on a laptop. Turning it on needs one thing this pass did not own: a
-- PATCH on /api/profile that accepts these fields. The shapes match the
-- TypeScript exactly, so the swap is `readMemory`/`writeMemory` and nothing
-- else.
--
-- It is also the owner's only view of whether the first four minutes work.
-- `profiles.created_at` to `onboarding_first_ready_at` is the time from signup
-- to a record that came back measured, which is the number the first handful
-- of invited producers exist to move.

alter table public.profiles
  -- they put the first-run strip away for good
  add column if not exists onboarding_dismissed_at timestamptz,
  -- the record that taught them, and when it came back
  add column if not exists onboarding_first_file_id uuid references public.files (id) on delete set null,
  add column if not exists onboarding_first_ready_at timestamptz,
  -- the record they had open when they left, so the way back in is one click
  add column if not exists onboarding_last_file_id uuid references public.files (id) on delete set null,
  -- the previous visit: what "while you were away" is measured from
  add column if not exists onboarding_last_seen_at timestamptz,
  -- they have been shown, at least once, that it needs their audio
  add column if not exists onboarding_seen_constraint boolean not null default false;

comment on column public.profiles.onboarding_first_ready_at is
  'When this account first saw an analyzed record. With created_at, the time from signup to the thing that makes the product make sense.';

-- No new policies: `profiles_select_own` and `profiles_update_own`
-- (20260913000400_billing.sql) already scope every column to the owner, and
-- the update policy keeps `plan` unwritable by the client. These columns are
-- the producer's own state, so the owner writing them is exactly right.
