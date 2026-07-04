-- ============================================================
-- 0033_finance.sql
-- Money & Finance:
--
--   payment_plans        : split a total into installments
--   payment_installments : each installment with due date, paid flag
--                          and auto SMS reminder bookkeeping
--   cheques              : post-dated cheque log with due-date alerts
--   expenses             : money-out tracker (drives profit snapshot
--                          and the tax/VAT export)
--
-- Money-in comes from the existing payments / company_payments /
-- invoices tables; the finance page combines both sides.
-- ============================================================

-- ---- Installment / payment plans ----------------------------
create table if not exists public.payment_plans (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  client_id    uuid references public.clients (id) on delete set null,
  lead_id      uuid references public.leads (id) on delete set null,
  invoice_id   uuid references public.invoices (id) on delete set null,
  -- Recipient for reminders (Notify.lk format) + display name.
  contact_name text not null default '',
  phone        text,
  total        numeric(14, 2) not null default 0,
  currency     text not null default 'LKR',
  notes        text,
  status       text not null default 'active'
               check (status in ('active', 'completed', 'cancelled')),
  -- Send an SMS reminder this many days before each due date (0 = on the day,
  -- null = reminders off).
  remind_days_before integer default 2,
  created_by   uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

drop trigger if exists payment_plans_set_updated_at on public.payment_plans;
create trigger payment_plans_set_updated_at
  before update on public.payment_plans
  for each row execute function public.set_updated_at();

create table if not exists public.payment_installments (
  id               uuid primary key default gen_random_uuid(),
  plan_id          uuid not null references public.payment_plans (id) on delete cascade,
  seq              integer not null default 1,
  amount           numeric(14, 2) not null default 0,
  due_date         date not null,
  status           text not null default 'pending'
                   check (status in ('pending', 'paid')),
  paid_at          timestamptz,
  -- Set when the pre-due reminder SMS went out so it only fires once.
  reminder_sent_at timestamptz,
  -- Set when the overdue chase SMS went out.
  overdue_sent_at  timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists payment_installments_plan_idx
  on public.payment_installments (plan_id, seq);
create index if not exists payment_installments_due_idx
  on public.payment_installments (status, due_date);

-- ---- Cheque tracking ----------------------------------------
create table if not exists public.cheques (
  id           uuid primary key default gen_random_uuid(),
  direction    text not null default 'received'
               check (direction in ('received', 'issued')),
  party_name   text not null,
  client_id    uuid references public.clients (id) on delete set null,
  bank         text,
  cheque_number text,
  amount       numeric(14, 2) not null default 0,
  currency     text not null default 'LKR',
  due_date     date not null,
  status       text not null default 'pending'
               check (status in ('pending', 'deposited', 'cleared', 'bounced', 'cancelled')),
  notes        text,
  -- Set once the due-date alert (notification + push) has fired.
  alerted_at   timestamptz,
  created_by   uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists cheques_due_idx on public.cheques (status, due_date);

drop trigger if exists cheques_set_updated_at on public.cheques;
create trigger cheques_set_updated_at
  before update on public.cheques
  for each row execute function public.set_updated_at();

-- ---- Expenses -----------------------------------------------
create table if not exists public.expenses (
  id             uuid primary key default gen_random_uuid(),
  expense_date   date not null default current_date,
  category       text not null default 'other'
                 check (category in (
                   'salaries', 'rent', 'software', 'ads', 'hosting',
                   'equipment', 'transport', 'utilities', 'fees', 'other'
                 )),
  description    text not null,
  vendor         text,
  amount         numeric(14, 2) not null default 0,
  currency       text not null default 'LKR',
  payment_method text,
  -- VAT/tax portion included in `amount` (for the tax export).
  tax_amount     numeric(14, 2) not null default 0,
  created_by     uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now()
);

create index if not exists expenses_date_idx on public.expenses (expense_date desc);

-- ---- RLS + realtime -----------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'payment_plans', 'payment_installments', 'cheques', 'expenses'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    begin
      execute format('create policy "%s: read all" on public.%I for select to authenticated using (true)', t, t);
    exception when duplicate_object then null; end;
    begin
      execute format('create policy "%s: insert all" on public.%I for insert to authenticated with check (true)', t, t);
    exception when duplicate_object then null; end;
    begin
      execute format('create policy "%s: update all" on public.%I for update to authenticated using (true) with check (true)', t, t);
    exception when duplicate_object then null; end;
    begin
      execute format('create policy "%s: delete all" on public.%I for delete to authenticated using (true)', t, t);
    exception when duplicate_object then null; end;
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when others then null; end;
  end loop;
end $$;
