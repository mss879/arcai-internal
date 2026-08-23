-- ============================================================
-- 0097_project_saved_views.sql
--
-- PROJECTS ROADMAP — theme 7 (VIEW), the one item that needs
-- schema.
--
-- VIEW-2 — SAVED FILTERS. The board grew search, six filters
-- and six sorts in LOOP-7, which answered "can I find one job"
-- and left "can I get back to the same question tomorrow"
-- unanswered. A saved view is a name for a set of filters —
-- "My active builds", "Unpaid deliveries", "Everything at
-- risk" — pinned above the board.
--
-- Deliberately a table rather than a column on profiles:
--   • a view can be SHARED, and the useful ones always are —
--     the whole team should be looking at the same "at risk";
--   • they are ordered, so the three that matter sit first;
--   • and one row per view means renaming or deleting one
--     can't rewrite the others.
--
-- `filters` is jsonb holding exactly the board's own filter
-- state (query, status, stage, client_id, service, owing,
-- sort, mode). Storing the shape the UI already uses means a
-- new filter needs no migration — it just starts being saved.
--
-- Everything else in theme 7 — the view modes, the month close
-- card, cycle-time analytics, CSV/PDF export and the dashboard
-- tiles — reads data that is already recorded and needs no
-- schema at all.
--
-- Safe to re-run: every statement is idempotent.
-- ============================================================

create table if not exists public.project_views (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  filters     jsonb not null default '{}'::jsonb,
  /** NULL = a view that belongs to the workspace rather than a person. */
  owner_id    uuid references public.profiles (id) on delete cascade,
  /** Shared views appear for everyone; private ones only for their owner. */
  shared      boolean not null default false,
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.project_views is
  'VIEW-2: a named set of board filters. `filters` mirrors the board''s own filter state verbatim, so adding a filter to the UI needs no migration here.';
comment on column public.project_views.owner_id is
  'Who made it. NULL means a workspace view with no owner. Private views (shared = false) are only listed for their owner.';
comment on column public.project_views.shared is
  'True = every teammate sees it on the board. The views worth having usually are — the team should be looking at the same "at risk".';

create index if not exists project_views_owner_idx
  on public.project_views (owner_id);
create index if not exists project_views_order_idx
  on public.project_views (position, created_at);

-- ---- RLS ----------------------------------------------------
-- Same shape as every other table in this workspace: it is
-- single-tenant and every authenticated user is a teammate.
-- The private/shared split is applied when reading, not here.
do $$
begin
  execute 'alter table public.project_views enable row level security';
  execute 'drop policy if exists "project_views: read all" on public.project_views';
  execute 'create policy "project_views: read all" on public.project_views for select to authenticated using (true)';
  execute 'drop policy if exists "project_views: insert all" on public.project_views';
  execute 'create policy "project_views: insert all" on public.project_views for insert to authenticated with check (true)';
  execute 'drop policy if exists "project_views: update all" on public.project_views';
  execute 'create policy "project_views: update all" on public.project_views for update to authenticated using (true) with check (true)';
  execute 'drop policy if exists "project_views: delete all" on public.project_views';
  execute 'create policy "project_views: delete all" on public.project_views for delete to authenticated using (true)';
end $$;

-- ---- updated_at ---------------------------------------------
drop trigger if exists project_views_set_updated_at on public.project_views;
create trigger project_views_set_updated_at
  before update on public.project_views
  for each row execute function public.set_updated_at();
