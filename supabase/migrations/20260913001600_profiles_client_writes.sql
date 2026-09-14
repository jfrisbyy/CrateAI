-- Let a producer write their own profile row again.
--
-- Found by the seams pass (docs/HANDOFF_seams.md) on a throwaway local cluster
-- with all thirteen migrations applied in order: every authenticated UPDATE on
-- `public.profiles` fails with
--
--     ERROR:  infinite recursion detected in policy for relation "profiles"
--
-- because `profiles_update_own` (20260913000400_billing.sql) reads
-- `public.profiles` from inside a policy on `public.profiles`:
--
--     with check ((select auth.uid()) = id
--                 and plan = (select p.plan from public.profiles p
--                              where p.id = (select auth.uid())))
--
-- Evaluating the policy needs a select on the table, which needs the policy.
-- Postgres detects the loop and raises rather than looping forever, so the
-- statement never runs. Nothing caught it because nothing had applied the
-- migrations together and then tried to write a row as a signed-in user.
--
-- What it breaks, today and ahead:
--
--   * `PATCH /api/profile { corrections_opt_in }` — the only profile write the
--     product shipped with — 500s (principle 7's opt-in switch).
--   * `profiles.loop_personalization` (20260913001200): the switch a producer
--     uses to stop their corrections adjusting their loop ranking.
--   * the six `onboarding_*` columns (20260913001500): every one of them is
--     written by the account that owns them, which is the entire point of
--     moving that state off the device.
--
-- The intent of the original clause was right and is kept: a client may edit
-- its own row but may not award itself a plan. It just cannot be expressed as
-- a self-referencing subquery. So the policy becomes the same four-line loop
-- every other table in the schema uses, and the part that has to compare the
-- old value with the new — which is what a policy cannot do and a trigger is
-- for — moves into a BEFORE UPDATE trigger that sees OLD and NEW directly and
-- never queries the table.
--
-- The trigger also closes a hole the original clause left open: it guarded
-- `plan` and nothing else, so a client could have written its own
-- `stripe_customer_id` or `stripe_subscription_id` — both `unique`, both read
-- by the Stripe webhook to decide whose plan to change.
--
-- NOT APPLIED. Run it with the Supabase CLI, after 20260913001500.

-- ---------------------------------------------------------------------------
-- the guard: what a client may not change about its own billing
-- ---------------------------------------------------------------------------

create or replace function public.profiles_guard_billing()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Only the two client roles are held to this. The Stripe webhook, the
  -- compute writers and the SQL editor all run as the service role or as the
  -- owner, and those are exactly the paths allowed to move an account's plan.
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if new.plan is distinct from old.plan then
    raise exception 'plan is set by billing, not by the account'
      using errcode = 'insufficient_privilege';
  end if;
  if new.plan_status is distinct from old.plan_status then
    raise exception 'plan_status is set by billing, not by the account'
      using errcode = 'insufficient_privilege';
  end if;
  if new.stripe_customer_id is distinct from old.stripe_customer_id
     or new.stripe_subscription_id is distinct from old.stripe_subscription_id then
    raise exception 'the Stripe ids are set by the billing webhook, not by the account'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

comment on function public.profiles_guard_billing() is
  'A client may edit its own profile row but not its plan, its plan status or its Stripe ids. '
  'This lives in a trigger rather than in the RLS policy because comparing OLD with NEW is what a '
  'trigger is for; the policy that tried to do it by reading the table recursed (see the header of '
  '20260913001600_profiles_client_writes.sql).';

drop trigger if exists profiles_guard_billing on public.profiles;
create trigger profiles_guard_billing
  before update on public.profiles
  for each row execute function public.profiles_guard_billing();

-- ---------------------------------------------------------------------------
-- the policy: the same shape as every other table
-- ---------------------------------------------------------------------------

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- ---------------------------------------------------------------------------
-- the advisor pass, extended to the tables that arrived after it
-- ---------------------------------------------------------------------------
--
-- 20260913000100_advisor_fixes.sql covered every foreign key in the init
-- schema. The billing migration landed after it and added three more that were
-- never covered; all three fire on a delete, which is when an unindexed foreign
-- key costs a full scan of the child table.
create index if not exists usage_events_job_idx on public.usage_events (job_id);
create index if not exists takedowns_file_idx on public.takedowns (file_id);
create index if not exists takedowns_user_idx on public.takedowns (user_id);
