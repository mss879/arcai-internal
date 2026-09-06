-- ============================================================
-- 0122_content_studio_notices_fix.sql
--
-- CATCH-UP FIX. Two much older migrations were never applied to the live
-- database, and nobody noticed until the tables that depend on them failed:
--
--   0025_content_studio.sql  →  content_references, content_generations
--                               (0118 alters content_generations, so 0118
--                                died with 42P01 "relation does not exist")
--   0060_notices.sql         →  notices
--                               (0120's numbering DO block reads notices,
--                                so 0120 died the same way)
--
-- This file re-states BOTH of those migrations so the gap can be closed in
-- one apply, then re-attaches the 0081 member-change audit trigger to the
-- three tables — 0081 loops over a table list guarded by `to_regclass`, so
-- it silently skipped all three when it ran and would never revisit them.
--
-- Nothing between 0025/0060 and now alters these tables (0046 and 0100 only
-- mention them in comments), so the definitions below are still current —
-- this is a genuine catch-up, not a rebuild.
--
-- Additive and idempotent: every object is `if not exists` or dropped first,
-- so it is safe to re-run, and safe on a database where some of it exists.
--
-- APPLY THIS BEFORE 0118 AND 0120.  Order: 0122 → 0118 → 0120.
-- ============================================================


-- ============================================================
-- PART A — from 0025_content_studio.sql
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

-- Dropped first so this file is re-runnable; `create policy` has no
-- `if not exists` and would abort the whole migration on a second apply.
drop policy if exists "content_references: read all"   on public.content_references;
drop policy if exists "content_references: write all"  on public.content_references;
drop policy if exists "content_references: update all" on public.content_references;
drop policy if exists "content_references: delete all" on public.content_references;

create policy "content_references: read all"
  on public.content_references for select to authenticated using (true);
create policy "content_references: write all"
  on public.content_references for insert to authenticated with check (true);
create policy "content_references: update all"
  on public.content_references for update to authenticated using (true) with check (true);
create policy "content_references: delete all"
  on public.content_references for delete to authenticated using (true);

drop policy if exists "content_generations: read all"   on public.content_generations;
drop policy if exists "content_generations: write all"  on public.content_generations;
drop policy if exists "content_generations: update all" on public.content_generations;
drop policy if exists "content_generations: delete all" on public.content_generations;

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

drop policy if exists "storage: public read content-references"  on storage.objects;
drop policy if exists "storage: public read content-generations" on storage.objects;
drop policy if exists "storage: auth insert content"             on storage.objects;
drop policy if exists "storage: auth update content"             on storage.objects;
drop policy if exists "storage: auth delete content"             on storage.objects;

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


-- ============================================================
-- PART B — from 0060_notices.sql
-- ============================================================

create table if not exists public.notices (
  id            uuid primary key default gen_random_uuid(),
  notice_number text not null,
  notice_date   date not null,
  to_name       text not null default '',
  to_details    text not null default '',
  -- The bold line above the greeting, e.g. "SCHEDULED MAINTENANCE".
  subject       text not null default '',
  -- The message itself. Paragraphs separated by blank lines. Excludes the
  -- "Dear Client," greeting — the template always prints that.
  body          text not null default '',
  -- What the user actually dictated/typed before the AI polished it. Kept so
  -- a past notice can be re-drafted from the original intent.
  source_input  text not null default '',
  -- Who the notice was emailed to, and when. Both optional; the send flow
  -- stamps them best-effort after a successful send (mirrors invoices, 0020).
  recipient_email text,
  sent_at         timestamptz,
  created_by    uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now()
);

create index if not exists notices_created_at_idx on public.notices (created_at desc);

alter table public.notices enable row level security;

drop policy if exists "notices: read all"   on public.notices;
drop policy if exists "notices: write all"  on public.notices;
drop policy if exists "notices: update all" on public.notices;
drop policy if exists "notices: delete all" on public.notices;

create policy "notices: read all"
  on public.notices for select to authenticated using (true);

create policy "notices: write all"
  on public.notices for insert to authenticated with check (true);

create policy "notices: update all"
  on public.notices for update to authenticated using (true) with check (true);

create policy "notices: delete all"
  on public.notices for delete to authenticated using (true);

-- Live updates for the "Past notices" tab (optional). Ignored if the
-- realtime publication is FOR ALL TABLES or already includes this table.
do $$
begin
  alter publication supabase_realtime add table public.notices;
exception
  when others then null;
end $$;


-- ============================================================
-- PART C — the audit trigger 0081 skipped
--
-- 0081_member_changes.sql attaches `member_changes_audit` to a fixed list of
-- tables, each guarded by `to_regclass(...) is not null`. All three tables
-- above were absent when it ran, so all three were skipped — and re-running
-- 0081 is not part of anyone's checklist. Attach them here instead.
--
-- Guarded on the function existing, so this is a no-op on a database where
-- 0081 itself was never applied.
-- ============================================================
do $$
declare
  t text;
begin
  if to_regprocedure('public.log_member_change()') is null then
    raise notice '0122: log_member_change() absent (0081 not applied) — skipping audit triggers.';
    return;
  end if;

  foreach t in array array['notices', 'content_generations'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists member_changes_audit on public.%I', t);
      execute format(
        'create trigger member_changes_audit
           after insert or update or delete on public.%I
           for each row execute function public.log_member_change()',
        t
      );
      raise notice '0122: member_changes_audit attached to %', t;
    end if;
  end loop;
end $$;
