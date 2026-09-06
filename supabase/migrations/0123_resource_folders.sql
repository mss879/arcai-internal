-- ============================================================
-- 0123_resource_folders.sql
-- Folders for the Resources library.
--
-- Until now /resources was one flat grid: every PDF, image and link the
-- workspace had ever uploaded, newest first, and nothing to group them by.
-- A folder is a named box you put resources in — one level deep, because
-- that is what was asked for and a tree nobody needs is a tree nobody
-- prunes.
--
-- A folder is NOT a resource. It gets its own table rather than a third
-- value on `resources.kind`, so every existing reader of that table keeps
-- returning only real files and links and none of them need a filter.
--
-- Idempotent throughout: policies are dropped before they are created,
-- because `create policy` has no `if not exists` and would otherwise abort
-- the whole file on a second apply.
-- ============================================================

create table if not exists public.resource_folders (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  created_by  uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists resource_folders_created_at_idx
  on public.resource_folders (created_at desc);

drop trigger if exists resource_folders_set_updated_at on public.resource_folders;
create trigger resource_folders_set_updated_at
  before update on public.resource_folders
  for each row execute function public.set_updated_at();

-- Which folder a resource sits in. NULL = loose at the top level, which is
-- every row that exists today.
alter table public.resources
  add column if not exists folder_id uuid
    references public.resource_folders (id) on delete set null;

comment on column public.resources.folder_id is
  'Folder the resource sits in; NULL means the top level. ON DELETE SET NULL '
  'on purpose: deleting a folder must never delete the files inside it — they '
  'fall back to the top level and the UI says so before you confirm.';

-- The list the folder view runs on every open.
create index if not exists resources_folder_idx
  on public.resources (folder_id, created_at desc);

alter table public.resource_folders enable row level security;

drop policy if exists "resource_folders: read all"   on public.resource_folders;
drop policy if exists "resource_folders: insert all" on public.resource_folders;
drop policy if exists "resource_folders: update all" on public.resource_folders;
drop policy if exists "resource_folders: delete all" on public.resource_folders;

-- Same posture as `resources` (0007): the whole workspace shares them.
create policy "resource_folders: read all" on public.resource_folders
  for select to authenticated using (true);
create policy "resource_folders: insert all" on public.resource_folders
  for insert to authenticated with check (true);
create policy "resource_folders: update all" on public.resource_folders
  for update to authenticated using (true) with check (true);
create policy "resource_folders: delete all" on public.resource_folders
  for delete to authenticated using (true);

-- Audit trail, same as `resources` -------------------------------------
-- 0081 attaches `member_changes_audit` by looping a fixed table list, and it
-- never revisits that list. So a table created afterwards gets the trigger
-- only if its own migration attaches it — which is exactly how 0025 and 0060
-- stayed invisible for sixty migrations. `resources` is on 0081's list;
-- creating and deleting the folders those files live in is the same kind of
-- member action, so it is logged the same way.
do $$
begin
  if to_regclass('public.resource_folders') is not null
     and to_regproc('public.log_member_change') is not null then
    drop trigger if exists member_changes_audit on public.resource_folders;
    create trigger member_changes_audit
      after insert or update or delete on public.resource_folders
      for each row execute function public.log_member_change();
  end if;
end $$;
