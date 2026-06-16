-- ============================================================
-- 0004_clients.sql
-- Shared client directory. Anyone in the workspace can manage.
-- ============================================================

create table if not exists public.clients (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  company     text,
  email       text,
  phone       text,
  city        text,
  status      text not null default 'active'
              check (status in ('active', 'lead', 'inactive')),
  notes       text,
  created_by  uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);

create index if not exists clients_created_at_idx on public.clients (created_at desc);

alter table public.clients enable row level security;

create policy "clients: read all"
  on public.clients for select to authenticated using (true);

create policy "clients: write all"
  on public.clients for insert to authenticated with check (true);

create policy "clients: update all"
  on public.clients for update to authenticated using (true) with check (true);

create policy "clients: delete all"
  on public.clients for delete to authenticated using (true);
