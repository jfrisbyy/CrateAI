-- Fixes from the Supabase advisors after the initial migration:
--   * set_updated_at had a role-mutable search_path
--   * the vector extension was installed in public
--   * foreign keys without covering indexes

alter function public.set_updated_at() set search_path = '';

alter extension vector set schema extensions;

create index if not exists breakdowns_user_idx on public.breakdowns (user_id);
create index if not exists chops_user_idx on public.chops (user_id);
create index if not exists chops_chop_file_idx on public.chops (chop_file_id);
create index if not exists comparisons_user_idx on public.comparisons (user_id);
create index if not exists comparisons_file_a_idx on public.comparisons (file_a_id);
create index if not exists comparisons_file_b_idx on public.comparisons (file_b_id);
create index if not exists conversations_user_idx on public.conversations (user_id, updated_at desc);
create index if not exists corrections_file_idx on public.corrections (file_id);
create index if not exists layer_items_file_idx on public.layer_items (file_id);
create index if not exists layer_items_user_idx on public.layer_items (user_id);
create index if not exists layers_render_file_idx on public.layers (render_file_id);
create index if not exists layers_user_idx on public.layers (user_id);
create index if not exists loops_render_file_idx on public.loops (render_file_id);
create index if not exists loops_user_idx on public.loops (user_id);
create index if not exists messages_user_idx on public.messages (user_id);
create index if not exists midi_user_idx on public.midi (user_id);
create index if not exists revoices_midi_idx on public.revoices (midi_id);
create index if not exists revoices_render_file_idx on public.revoices (render_file_id);
create index if not exists revoices_user_idx on public.revoices (user_id);
create index if not exists stems_stem_file_idx on public.stems (stem_file_id);
create index if not exists stems_user_idx on public.stems (user_id);
