-- ============================================================
-- 0025_content_studio.sql
-- Content Studio — AI image generation with Gemini 3.1 Flash
-- Image ("Nano Banana 2"). Two tables + two storage buckets:
--   content_references  : brand reference images reused as a guide
--   content_generations : every image the studio produces (history)
-- Shared across the workspace, mirroring proposals (0023).
-- ============================================================

-- ---- Reference library --------------------------------------
create table if not exists public.content_references (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default '',
  description text not null default '',
  image_url   text not null,
  image_path  text not null,
  mime_type   text not null default 'image/png',
  created_by  uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);

create index if not exists content_references_created_at_idx
  on public.content_references (created_at desc);

-- ---- Generation history -------------------------------------
create table if not exists public.content_generations (
  id            uuid primary key default gen_random_uuid(),
  prompt        text not null default '',
  image_url     text not null,
  image_path    text not null,
  mime_type     text not null default 'image/png',
  -- What the user picked, kept for "regenerate" + display.
  aspect_ratio  text not null default '1:1',
  image_size    text not null default '2K',
  model         text not null default '',
  -- ids of the content_references included as a guide (snapshot).
  reference_ids jsonb not null default '[]'::jsonb,
  created_by    uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now()
);

create index if not exists content_generations_created_at_idx
  on public.content_generations (created_at desc);

-- ---- RLS (single-workspace: any authenticated member) -------
alter table public.content_references  enable row level security;
alter table public.content_generations enable row level security;

create policy "content_references: read all"
  on public.content_references for select to authenticated using (true);
create policy "content_references: write all"
  on public.content_references for insert to authenticated with check (true);
create policy "content_references: update all"
  on public.content_references for update to authenticated using (true) with check (true);
create policy "content_references: delete all"
  on public.content_references for delete to authenticated using (true);

create policy "content_generations: read all"
  on public.content_generations for select to authenticated using (true);
create policy "content_generations: write all"
  on public.content_generations for insert to authenticated with check (true);
create policy "content_generations: update all"
  on public.content_generations for update to authenticated using (true) with check (true);
create policy "content_generations: delete all"
  on public.content_generations for delete to authenticated using (true);

-- ---- Storage buckets ----------------------------------------
insert into storage.buckets (id, name, public)
values
  ('content-references',  'content-references',  true),
  ('content-generations', 'content-generations', true)
on conflict (id) do nothing;

create policy "storage: public read content-references"
  on storage.objects for select
  using (bucket_id = 'content-references');

create policy "storage: public read content-generations"
  on storage.objects for select
  using (bucket_id = 'content-generations');

create policy "storage: auth insert content"
  on storage.objects for insert
  to authenticated
  with check (bucket_id in ('content-references', 'content-generations'));

create policy "storage: auth update content"
  on storage.objects for update
  to authenticated
  using (bucket_id in ('content-references', 'content-generations'))
  with check (bucket_id in ('content-references', 'content-generations'));

create policy "storage: auth delete content"
  on storage.objects for delete
  to authenticated
  using (bucket_id in ('content-references', 'content-generations'));

-- ---- Live updates (optional; ignored if FOR ALL TABLES) -----
do $$
begin
  alter publication supabase_realtime add table public.content_references;
exception when others then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.content_generations;
exception when others then null;
end $$;
