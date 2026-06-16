-- ============================================================
-- 0007_resources.sql
-- Shared resources: uploaded files (PDF / images / docs) or links.
-- ============================================================

create table if not exists public.resources (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  kind        text not null default 'file' check (kind in ('file', 'link')),
  file_url    text,
  file_path   text,
  file_type   text,
  file_size   bigint,
  link_url    text,
  uploaded_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);

create index if not exists resources_created_at_idx on public.resources (created_at desc);

alter table public.resources enable row level security;

create policy "resources: read all" on public.resources
  for select to authenticated using (true);
create policy "resources: insert all" on public.resources
  for insert to authenticated with check (true);
create policy "resources: update all" on public.resources
  for update to authenticated using (true) with check (true);
create policy "resources: delete all" on public.resources
  for delete to authenticated using (true);
