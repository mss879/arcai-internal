-- ============================================================
-- 0090_projects_archive.sql
--
-- PROJECTS, THEME 1 (LOOP) — the only schema this theme needs.
--
-- Deleting a project cascades its payments, its expenses, its
-- asset requests and its whole delivery history, and orphans
-- the commissions allocated against it. That is one confirm
-- dialog away from losing the financial record of a job.
--
-- Projects now archive instead: `deleted_at` hides the project
-- from every list, the row and everything hanging off it stay
-- exactly where they are, and it can be restored. This is the
-- pattern the CRM already uses for leads (/crm/trash).
--
-- Hard delete is still available from the Trash view for a
-- project created by mistake — that path is unchanged.
--
-- Safe to re-run: every statement is idempotent.
-- ============================================================

alter table public.projects
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.profiles (id) on delete set null;

comment on column public.projects.deleted_at is
  'When the project was archived. NULL = live. Archived projects are hidden from every board, picker, count and automation scan, but keep all their payments, expenses, commissions and delivery history so the money record survives. Restored by clearing this column.';

-- Every list query filters on `deleted_at is null`, so index exactly that.
create index if not exists projects_live_idx
  on public.projects (created_at desc)
  where deleted_at is null;

-- Archiving/restoring a project is a money-relevant edit — same audit trail
-- the expenses table got in 0087. Service-role writes stay unlogged by design.
do $$
begin
  if to_regclass('public.member_changes') is not null then
    drop trigger if exists member_changes_audit on public.projects;
    create trigger member_changes_audit
      after insert or update or delete on public.projects
      for each row execute function public.log_member_change();
  end if;
end $$;
