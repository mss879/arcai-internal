-- ============================================================
-- 0026_website_progress.sql
-- Website Progress — track the build status of each client site.
-- One row per client website: its URL, how far along the build is
-- (0–100%), whether we're currently blocked waiting on the client,
-- and whether it has been launched (gone live).
-- Shared across the workspace, mirroring proposals (0023).
-- ============================================================

create table if not exists public.website_projects (
  id           uuid primary key default gen_random_uuid(),
  -- Label for the site (usually the client / business name).
  name         text not null default '',
  -- The client's website URL (may be a staging link before launch).
  url          text not null default '',
  -- Optional link to a client record, kept loose (set null on delete).
  client_id    uuid references public.clients (id) on delete set null,
  -- How much of the build is done, 0–100.
  progress     integer not null default 0 check (progress between 0 and 100),
  -- Where the build stands:
  --   in_progress   : actively being built
  --   waiting_client : blocked, waiting for the client to reply
  --   launched       : complete and live
  status       text not null default 'in_progress'
               check (status in ('in_progress', 'waiting_client', 'launched')),
  -- Free-form notes (what's outstanding, what we're waiting on, etc.).
  notes        text not null default '',
  -- Stamped when the site is launched via the "Launch" button.
  launched_at  timestamptz,
  created_by   uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists website_projects_created_at_idx
  on public.website_projects (created_at desc);

-- Keep updated_at fresh on every edit.
create or replace function public.set_website_projects_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists website_projects_set_updated_at on public.website_projects;
create trigger website_projects_set_updated_at
  before update on public.website_projects
  for each row execute function public.set_website_projects_updated_at();

-- ---- RLS (single-workspace: any authenticated member) -------
alter table public.website_projects enable row level security;

create policy "website_projects: read all"
  on public.website_projects for select to authenticated using (true);
create policy "website_projects: write all"
  on public.website_projects for insert to authenticated with check (true);
create policy "website_projects: update all"
  on public.website_projects for update to authenticated using (true) with check (true);
create policy "website_projects: delete all"
  on public.website_projects for delete to authenticated using (true);

-- ---- Live updates (optional; ignored if FOR ALL TABLES) -----
do $$
begin
  alter publication supabase_realtime add table public.website_projects;
exception when others then null;
end $$;
