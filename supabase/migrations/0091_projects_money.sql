-- ============================================================
-- 0091_projects_money.sql
--
-- PROJECTS, THEME 2 (MON) — margin, schedules and chasing.
--
-- The module tracked revenue precisely and profit not at all.
-- Every number needed for a real margin was already stored —
-- contract value, billable extras, absorbed costs, commissions
-- — they had simply never been subtracted from each other.
-- Margin itself needs no schema; these are the columns the
-- rest of the theme needs:
--
--   1. BUDGET BURN — `budget` was an inert figure on the
--      header. It becomes a burn bar against recorded
--      expenses, and alerts once when a project goes over.
--
--   2. PAYMENT SCHEDULES — payment_plans gains project_id, so
--      a 40/40/20 split belongs to the job it is billing.
--      Finance already texts a reminder before each due date
--      and chases the day after one goes overdue (finance.ts);
--      this just gives those reminders a project.
--
--   3. INVOICES ↔ PROJECTS — a generated invoice can finally
--      say which project it billed, which is what makes
--      "invoice the balance when it hits Delivered" traceable
--      rather than a document that appears from nowhere.
--
--   4. DEPOSIT GATE — a project can be held out of Build until
--      an agreed share of its value has landed.
--
--   5. RETAINERS — a project marked recurring regenerates
--      itself next month, carrying its template forward. The
--      parent link keeps the whole series queryable.
--
--   6. COMMISSION BASIS — a commission can be a fixed amount
--      (today's behaviour, unchanged) or a percentage that
--      accrues as the client actually pays.
--
--   7. BALANCE CHASE LADDER — the bookkeeping that lets an
--      unpaid balance be chased on an escalating schedule
--      exactly once per step.
--
-- Safe to re-run: every statement is idempotent.
-- ============================================================

-- 1 + 4 + 5 + 7: project-level columns ------------------------
alter table public.projects
  -- Budget burn: stamped when the over-budget alert fires, so it fires once.
  add column if not exists budget_alerted_at timestamptz,
  -- Absorbed + billable costs may not exceed this before the team is warned.
  -- NULL = fall back to `budget`.
  add column if not exists expense_cap numeric(14, 2),
  -- Deposit gate: the share of total_value that must be received before the
  -- project may leave the assets stage. NULL = no gate (today's behaviour).
  add column if not exists deposit_required_percent numeric(5, 2)
    check (deposit_required_percent is null
           or (deposit_required_percent >= 0 and deposit_required_percent <= 100)),
  -- Retainers.
  add column if not exists is_retainer boolean not null default false,
  add column if not exists retainer_day integer
    check (retainer_day is null or (retainer_day >= 1 and retainer_day <= 28)),
  add column if not exists retainer_parent_id uuid
    references public.projects (id) on delete set null,
  add column if not exists retainer_last_run_on date,
  -- Balance chase ladder.
  add column if not exists balance_chase_count integer not null default 0,
  add column if not exists balance_chased_at timestamptz,
  add column if not exists balance_chase_paused boolean not null default false,
  -- Auto-invoice the balance when the project reaches Delivered.
  add column if not exists auto_invoice_on_delivery boolean not null default false;

comment on column public.projects.deposit_required_percent is
  'Share of total_value that must be received before the project may move past Collecting assets. NULL = no gate. The gate warns and asks for confirmation; it never silently blocks work that has already been agreed.';
comment on column public.projects.is_retainer is
  'TRUE = a recurring engagement. On retainer_day each month the tick creates next month''s project from this one (same client, value, checklist and task template) and links it back via retainer_parent_id.';
comment on column public.projects.retainer_last_run_on is
  'The month this retainer last produced a child project. The single guard against generating the same month twice when the tick runs every minute.';
comment on column public.projects.balance_chase_count is
  'How many balance reminders have gone out since the project was delivered. Drives the escalating ladder (friendly → firm → notice) and resets to 0 the moment the balance is settled.';

create index if not exists projects_retainer_due_idx
  on public.projects (retainer_day)
  where is_retainer and deleted_at is null;

-- 2. Payment schedules belong to a project --------------------
alter table public.payment_plans
  add column if not exists project_id uuid
    references public.projects (id) on delete set null;

comment on column public.payment_plans.project_id is
  'The project this schedule bills. NULL = a standalone plan with no project (the old behaviour), which keeps every existing row working untouched.';

create index if not exists payment_plans_project_idx
  on public.payment_plans (project_id);

-- 3. Invoices know what they billed ---------------------------
alter table public.invoices
  add column if not exists project_id uuid
    references public.projects (id) on delete set null;

comment on column public.invoices.project_id is
  'The project this invoice billed. NULL = a standalone invoice. Set automatically by the project''s "Generate invoice" hand-off and by the auto-invoice-on-delivery step.';

create index if not exists invoices_project_idx
  on public.invoices (project_id);

-- 6. Commission basis -----------------------------------------
alter table public.commissions
  add column if not exists basis text not null default 'fixed';

alter table public.commissions drop constraint if exists commissions_basis_check;
alter table public.commissions add constraint commissions_basis_check
  check (basis in ('fixed', 'percent_of_received'));

comment on column public.commissions.basis is
  '''fixed'' = the stored amount is owed in full once approved (every commission written before 0091). ''percent_of_received'' = `percentage` of what the client has actually paid, so the earned figure grows with the money in and nobody is owed commission on an invoice that never got settled.';

-- Expense categories are reported on now, so make the column searchable.
create index if not exists project_expenses_category_idx
  on public.project_expenses (category)
  where category is not null;
