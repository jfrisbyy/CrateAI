-- Product hardening (BUILD_PACKET section 18, Phase 10): profiles with a plan,
-- usage metering, and the DMCA takedown queue.

-- ---------------------------------------------------------------------------
-- profiles: one per auth user, created by trigger
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  plan_status text not null default 'active' check (plan_status in ('active', 'past_due', 'canceled', 'trialing')),
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  corrections_opt_in boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;

create policy profiles_select_own on public.profiles
  for select to authenticated using ((select auth.uid()) = id);

create policy profiles_update_own on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id and plan = (select p.plan from public.profiles p where p.id = (select auth.uid())));

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

insert into public.profiles (id, email)
select u.id, u.email from auth.users u
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- usage_events: what gets metered (storage is derived from files.size_bytes)
-- ---------------------------------------------------------------------------

create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('gpu_seconds', 'cpu_seconds', 'chat_turn', 'web_search', 'stem_job')),
  amount numeric not null default 1,
  job_id uuid references public.jobs (id) on delete set null,
  created_at timestamptz not null default now()
);

create index usage_events_user_kind_created_idx on public.usage_events (user_id, kind, created_at desc);

alter table public.usage_events enable row level security;

create policy usage_events_select_own on public.usage_events
  for select to authenticated using ((select auth.uid()) = user_id);
-- writes come from server routes and compute with the service role

create or replace function public.usage_summary(p_since timestamptz default date_trunc('month', now()))
returns table (kind text, total numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select e.kind, sum(e.amount) as total
  from public.usage_events e
  where e.user_id = (select auth.uid()) and e.created_at >= p_since
  group by e.kind
  union all
  select 'storage_bytes', coalesce(sum(f.size_bytes), 0)
  from public.files f
  where f.user_id = (select auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- takedowns: DMCA notices, service role only (the public form posts through a server route)
-- ---------------------------------------------------------------------------

create table public.takedowns (
  id uuid primary key default gen_random_uuid(),
  claimant_name text not null,
  claimant_email text not null,
  claimant_address text,
  work_description text not null,
  infringing_description text not null,
  good_faith boolean not null default false,
  accuracy_sworn boolean not null default false,
  signature text not null,
  file_id uuid references public.files (id) on delete set null,
  user_id uuid references auth.users (id) on delete set null,
  status text not null default 'received'
    check (status in ('received', 'reviewing', 'removed', 'counter_noticed', 'restored', 'rejected')),
  notes text,
  source_ip text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger takedowns_set_updated_at
  before update on public.takedowns
  for each row execute function public.set_updated_at();

alter table public.takedowns enable row level security;
-- no policies: only the service role reads or writes takedowns
