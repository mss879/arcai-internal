-- ============================================================
-- 0087_project_expenses.sql
--
-- Two changes to Projects, shipped together because they answer
-- the same complaint: "a project I'm still working on is buried
-- under the month I created it in, and the extra costs it picked
-- up along the way live nowhere at all".
--
--   1. CARRY FORWARD — the board groups projects by the month
--      they were created, so a June project still being built in
--      August is only findable by scrolling back to June.
--      `carry_forward` (default TRUE) lets an unfinished project
--      — status not completed/cancelled — list under the CURRENT
--      month instead, tagged "Continuing from June 2026" so the
--      month it really started in is never lost. Set it FALSE to
--      pin one project back to its creation month (the old
--      behaviour, now per-project). Once a project is completed
--      or cancelled it files itself back under the month it was
--      created, whatever this column says.
--
--   2. PROJECT_EXPENSES — the "Additional expenses" tab. Every
--      cost a project picks up after it was quoted (a plugin
--      licence, a stock pack, an extra page, hosting the client
--      agreed to) recorded against the project, marked billable
--      or absorbed, and stamped `invoiced_at` the moment it goes
--      onto an invoice so it can never be billed twice.
--      "Generate invoice" on that tab adds total_value + the
--      billable, not-yet-invoiced expenses, subtracts what the
--      client has already paid, and hands the result to the
--      existing branded invoice template.
--
-- Safe to re-run: every statement is idempotent.
-- ============================================================

-- 1. Carry forward -------------------------------------------
alter table public.projects
  add column if not exists carry_forward boolean not null default true;

comment on column public.projects.carry_forward is
  'TRUE (default) = while unfinished, this project lists under the CURRENT month on the Projects board, tagged with the month it was created. FALSE = pinned to its creation month. Completed/cancelled projects always file under their creation month.';

-- 2. Additional expenses -------------------------------------
create table if not exists public.project_expenses (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  -- What it was, in invoice language — this becomes the line item.
  description  text not null,
  -- The longer explanation printed under the line item.
  detail       text,
  category     text,
  vendor       text,
  qty          numeric(12, 2) not null default 1,
  unit_amount  numeric(14, 2) not null default 0,
  currency     text not null default 'LKR',
  incurred_on  date not null default current_date,
  -- FALSE = a cost the agency absorbs; it is never offered to the invoice.
  billable     boolean not null default true,
  -- Stamped when the expense is put on an invoice. The single guard
  -- against billing the same extra cost twice.
  invoiced_at  timestamptz,
  invoiced_by  uuid references public.profiles (id) on delete set null,
  -- Supplier receipt / bill, kept in the existing `receipts` bucket.
  receipt_url  text,
  receipt_path text,
  notes        text,
  created_by   uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Re-run safety: bring an older/partial table up to the full shape.
alter table public.project_expenses
  add column if not exists detail       text,
  add column if not exists category     text,
  add column if not exists vendor       text,
  add column if not exists qty          numeric(12, 2) not null default 1,
  add column if not exists unit_amount  numeric(14, 2) not null default 0,
  add column if not exists currency     text not null default 'LKR',
  add column if not exists incurred_on  date not null default current_date,
  add column if not exists billable     boolean not null default true,
  add column if not exists invoiced_at  timestamptz,
  add column if not exists invoiced_by  uuid references public.profiles (id) on delete set null,
  add column if not exists receipt_url  text,
  add column if not exists receipt_path text,
  add column if not exists notes        text,
  add column if not exists updated_at   timestamptz not null default now();

-- The line total. Generated, so qty × rate and the figure the invoice
-- picks up can never drift apart.
alter table public.project_expenses
  add column if not exists amount numeric(14, 2)
    generated always as (round(qty * unit_amount, 2)) stored;

comment on column public.project_expenses.amount is
  'qty × unit_amount, maintained by Postgres. Charge a flat cost as qty 1 × the amount.';
comment on column public.project_expenses.invoiced_at is
  'When this expense was put on an invoice. NULL = still waiting to be billed; "Generate invoice" only ever offers NULL rows.';

create index if not exists project_expenses_project_idx
  on public.project_expenses (project_id, incurred_on desc);

-- The lookup the Generate-invoice button makes: what is still owed to us.
create index if not exists project_expenses_unbilled_idx
  on public.project_expenses (project_id)
  where billable and invoiced_at is null;

alter table public.project_expenses enable row level security;

-- Same access as projects/payments (0006): one workspace, every signed-in
-- member works the same board.
drop policy if exists "project_expenses: read all" on public.project_expenses;
create policy "project_expenses: read all" on public.project_expenses
  for select to authenticated using (true);

drop policy if exists "project_expenses: insert all" on public.project_expenses;
create policy "project_expenses: insert all" on public.project_expenses
  for insert to authenticated with check (true);

drop policy if exists "project_expenses: update all" on public.project_expenses;
create policy "project_expenses: update all" on public.project_expenses
  for update to authenticated using (true) with check (true);

drop policy if exists "project_expenses: delete all" on public.project_expenses;
create policy "project_expenses: delete all" on public.project_expenses
  for delete to authenticated using (true);

-- Keep updated_at honest (generic touch function from 0001).
drop trigger if exists project_expenses_set_updated_at on public.project_expenses;
create trigger project_expenses_set_updated_at
  before update on public.project_expenses
  for each row execute function public.set_updated_at();

-- 3. Realtime for the new table (0021 guard pattern) ---------
do $$
begin
  begin
    execute 'alter publication supabase_realtime add table public.project_expenses';
  exception
    when duplicate_object then null; -- already published
    when others then null;           -- e.g. publication is FOR ALL TABLES
  end;
end $$;

-- 4. Member-change audit (0081 pattern) ----------------------
-- Money added to a project is exactly the kind of edit the Team ▸ Activity
-- ▸ Changes trail exists for. Service-role writes stay unlogged, by design.
do $$
begin
  if to_regclass('public.member_changes') is not null then
    drop trigger if exists member_changes_audit on public.project_expenses;
    create trigger member_changes_audit
      after insert or update or delete on public.project_expenses
      for each row execute function public.log_member_change();
  end if;
end $$;
