-- ============================================================
-- 0100_finance_project_costs_and_recurring_income.sql
--
-- Two gaps between Money & Finance and Projects.
--
-- ------------------------------------------------------------
-- 1. FINANCE COSTS COUNT AGAINST A PROJECT
-- ------------------------------------------------------------
-- There are two expense ledgers and they have never spoken:
--
--   • project_expenses (0087) — costs raised ON a project, most
--     of them billable extras that go onto the client's invoice.
--   • expenses (0021) — the company ledger: salaries, rent,
--     software, hosting, ads. Real money, attributed to nothing.
--
-- MON-1 computes margin from the first and is blind to the
-- second. A project whose hosting, stock photos and paid ads
-- were all booked in Finance reads as pure profit, which is an
-- empty cost sheet wearing a margin's clothes — the exact thing
-- marginIsMeaningful() was written to prevent.
--
-- `expenses.project_id` closes it. A Finance expense tagged to
-- a project counts as an ABSORBED cost there: the agency paid
-- it and is not re-billing it. Anything meant to go back on the
-- client's invoice belongs in project_expenses, where `billable`
-- already means exactly that — so the two ledgers stay distinct
-- and nothing is ever counted twice.
--
-- ------------------------------------------------------------
-- 2. MONEY THAT ARRIVES EVERY MONTH
-- ------------------------------------------------------------
-- Finance tracks one-off installments, cheques and project
-- payments. It has no idea about the money that simply turns up
-- every month — hosting, maintenance, a social-media retainer.
-- That income is invisible until someone remembers to type it
-- in, and nobody notices when a month is missed.
--
-- `recurring_income` is the standing arrangement; each month the
-- tick materialises one `recurring_income_entries` row for it,
-- which the team marks received (or skips). Two tables rather
-- than one because "we are owed 25,000 a month" and "March's
-- 25,000 landed on the 4th" are different facts, and only the
-- second belongs in a cash-flow chart.
--
-- DELIBERATELY NOT project money. A schedule may name a project
-- for reporting, but a received entry never touches that
-- project's `received` figure: monthly hosting is not part of
-- the build's contract value, and settledAmount() reconciling
-- two payment tables is already the subtlest thing in this
-- schema (invariant 1). It is company income, and it is shown
-- as company income.
--
-- Additive and idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Finance expenses can belong to a project
-- ------------------------------------------------------------

alter table public.expenses
  add column if not exists project_id uuid
    references public.projects (id) on delete set null;

comment on column public.expenses.project_id is
  'The project this company cost belongs to. NULL = general overhead. Counts as an ABSORBED cost on that project''s margin — never as a billable extra, because a cost you intend to re-bill belongs in project_expenses where `billable` says so.';

create index if not exists expenses_project_idx
  on public.expenses (project_id)
  where project_id is not null;

-- ------------------------------------------------------------
-- 2. Recurring income
-- ------------------------------------------------------------

create table if not exists public.recurring_income (
  id           uuid primary key default gen_random_uuid(),
  /** What it is, in the team's words: "Cafe Aroma — hosting & care". */
  label        text not null,
  client_id    uuid references public.clients (id) on delete set null,
  /** Attribution only — see the header. Never added to project money. */
  project_id   uuid references public.projects (id) on delete set null,
  amount       numeric(12, 2) not null default 0,
  currency     text not null default 'LKR',
  /** 1-28: later days do not exist in every month. */
  day_of_month integer not null default 1,
  category     text not null default 'retainer',
  is_active    boolean not null default true,
  /** Nothing is generated before this date, or after ended_on. */
  started_on   date not null default current_date,
  ended_on     date,
  /** Bookkeeping: the month last materialised, so a tick can't double up. */
  last_run_on  date,
  notes        text,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.recurring_income drop constraint if exists recurring_income_day_check;
alter table public.recurring_income add constraint recurring_income_day_check
  check (day_of_month between 1 and 28);

alter table public.recurring_income drop constraint if exists recurring_income_category_check;
alter table public.recurring_income add constraint recurring_income_category_check
  check (category in ('retainer', 'hosting', 'maintenance', 'subscription', 'rent', 'other'));

comment on table public.recurring_income is
  'A standing monthly arrangement — hosting, care plans, social-media retainers. The schedule, not the money: each month''s actual receipt is a recurring_income_entries row.';
comment on column public.recurring_income.project_id is
  'For reporting only. A received entry never counts toward the project''s `received` — monthly hosting is not part of the build''s contract value.';
comment on column public.recurring_income.last_run_on is
  'The date an entry was last generated. The generator also checks for an existing entry in the month, so this is belt AND braces.';

create index if not exists recurring_income_active_idx
  on public.recurring_income (is_active, day_of_month);
create index if not exists recurring_income_client_idx
  on public.recurring_income (client_id);

create table if not exists public.recurring_income_entries (
  id           uuid primary key default gen_random_uuid(),
  income_id    uuid not null references public.recurring_income (id) on delete cascade,
  /** The month this covers, always the 1st: 2026-08-01. */
  period       date not null,
  due_date     date not null,
  /** Copied from the schedule so a later price change can't rewrite history. */
  amount       numeric(12, 2) not null default 0,
  currency     text not null default 'LKR',
  status       text not null default 'pending',
  received_on  date,
  received_by  uuid references public.profiles (id) on delete set null,
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.recurring_income_entries
  drop constraint if exists recurring_income_entries_status_check;
alter table public.recurring_income_entries
  add constraint recurring_income_entries_status_check
  check (status in ('pending', 'received', 'skipped'));

comment on column public.recurring_income_entries.amount is
  'Copied from the schedule when the entry is generated. Raising the price next year must not silently restate what was billed last year.';

-- One entry per arrangement per month, whatever the tick does.
create unique index if not exists recurring_income_entries_period_idx
  on public.recurring_income_entries (income_id, period);
create index if not exists recurring_income_entries_status_idx
  on public.recurring_income_entries (status, due_date);

-- ---- RLS ----------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['recurring_income', 'recurring_income_entries'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "%s: read all" on public.%I', t, t);
    execute format('create policy "%s: read all" on public.%I for select to authenticated using (true)', t, t);
    execute format('drop policy if exists "%s: insert all" on public.%I', t, t);
    execute format('create policy "%s: insert all" on public.%I for insert to authenticated with check (true)', t, t);
    execute format('drop policy if exists "%s: update all" on public.%I', t, t);
    execute format('create policy "%s: update all" on public.%I for update to authenticated using (true) with check (true)', t, t);
    execute format('drop policy if exists "%s: delete all" on public.%I', t, t);
    execute format('create policy "%s: delete all" on public.%I for delete to authenticated using (true)', t, t);
  end loop;
end $$;

-- ---- updated_at ---------------------------------------------
drop trigger if exists recurring_income_set_updated_at on public.recurring_income;
create trigger recurring_income_set_updated_at
  before update on public.recurring_income
  for each row execute function public.set_updated_at();

drop trigger if exists recurring_income_entries_set_updated_at on public.recurring_income_entries;
create trigger recurring_income_entries_set_updated_at
  before update on public.recurring_income_entries
  for each row execute function public.set_updated_at();
