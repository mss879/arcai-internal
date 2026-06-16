-- ============================================================
-- 0009_crm.sql
-- Public CRM: pipelines -> stages -> leads (drag & drop board).
-- Anyone in the workspace can add and move leads.
-- ============================================================

create table if not exists public.pipelines (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  position    int  not null default 0,
  created_by  uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);

alter table public.pipelines enable row level security;

create policy "pipelines: read all" on public.pipelines
  for select to authenticated using (true);
create policy "pipelines: insert all" on public.pipelines
  for insert to authenticated with check (true);
create policy "pipelines: update all" on public.pipelines
  for update to authenticated using (true) with check (true);
create policy "pipelines: delete all" on public.pipelines
  for delete to authenticated using (true);

-- Stages -------------------------------------------------------
create table if not exists public.pipeline_stages (
  id          uuid primary key default gen_random_uuid(),
  pipeline_id uuid not null references public.pipelines (id) on delete cascade,
  name        text not null,
  color       text not null default '#6d5cff',
  position    int  not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists pipeline_stages_pipeline_idx on public.pipeline_stages (pipeline_id);

alter table public.pipeline_stages enable row level security;

create policy "pipeline_stages: read all" on public.pipeline_stages
  for select to authenticated using (true);
create policy "pipeline_stages: insert all" on public.pipeline_stages
  for insert to authenticated with check (true);
create policy "pipeline_stages: update all" on public.pipeline_stages
  for update to authenticated using (true) with check (true);
create policy "pipeline_stages: delete all" on public.pipeline_stages
  for delete to authenticated using (true);

-- Leads --------------------------------------------------------
create table if not exists public.leads (
  id            uuid primary key default gen_random_uuid(),
  pipeline_id   uuid not null references public.pipelines (id) on delete cascade,
  stage_id      uuid references public.pipeline_stages (id) on delete set null,
  title         text not null,
  company       text,
  contact_name  text,
  contact_email text,
  contact_phone text,
  value         numeric(14, 2),
  currency      text not null default 'USD',
  notes         text,
  position      int  not null default 0,
  assigned_to   uuid references public.profiles (id) on delete set null,
  client_id     uuid references public.clients (id) on delete set null,
  created_by    uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists leads_pipeline_idx on public.leads (pipeline_id);
create index if not exists leads_stage_idx on public.leads (stage_id);

drop trigger if exists leads_set_updated_at on public.leads;
create trigger leads_set_updated_at
  before update on public.leads
  for each row execute function public.set_updated_at();

alter table public.leads enable row level security;

create policy "leads: read all" on public.leads
  for select to authenticated using (true);
create policy "leads: insert all" on public.leads
  for insert to authenticated with check (true);
create policy "leads: update all" on public.leads
  for update to authenticated using (true) with check (true);
create policy "leads: delete all" on public.leads
  for delete to authenticated using (true);
