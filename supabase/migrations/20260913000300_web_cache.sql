-- Web information tools (BUILD_PACKET section 13): a query cache with a 24 h TTL.
-- Read and written only by web server routes with the service role; no client access.

create table public.web_cache (
  key text primary key,
  provider text not null,
  kind text not null check (kind in ('search', 'fetch')),
  query text not null,
  response jsonb not null,
  created_at timestamptz not null default now()
);

create index web_cache_created_idx on public.web_cache (created_at);

alter table public.web_cache enable row level security;
-- no policies: only the service role can read or write this table
