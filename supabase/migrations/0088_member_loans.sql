-- ============================================================
-- 0088_member_loans.sql
--
-- STAFF LOANS / ADVANCES, netted off commission.
--
-- A member asks for money up front. The admin records the loan
-- against them, and from that moment their commission balance
-- shows LESS by exactly that amount — the money has effectively
-- already been paid out. As they pay it back, each repayment
-- releases that much commission again, until the loan is clear
-- and their balance is whole.
--
-- Nothing rewrites the commission rows themselves: a commission
-- is what was earned, and stays that. The loan is a second
-- ledger the app nets against it, so
--
--     available commission = commissions − outstanding loans
--
-- which moves the moment a loan or a repayment is recorded, and
-- can always be traced back to the rows that caused it.
--
--   • MEMBER_LOANS — one row per advance: amount, why, when it
--     was issued, when it's due back, and a status that the
--     database keeps honest (see the trigger below). Written off
--     is a deliberate third state: the money is gone, stop
--     deducting it from what they're owed.
--
--   • MEMBER_LOAN_REPAYMENTS — one row per payment back, so a
--     loan can be settled in instalments and every instalment
--     is on the record.
--
--   • The status trigger — `outstanding` flips to `repaid` the
--     instant repayments cover the loan, and back again if a
--     repayment is corrected or removed. No screen has to
--     remember to do it, so no screen can forget.
--
-- Visibility mirrors commissions (0006): a member sees their own
-- loans, admins see everyone's, and only an admin can issue one,
-- edit one, or record a repayment.
--
-- Safe to re-run: every statement is idempotent.
-- ============================================================

-- 1. Loans ---------------------------------------------------
create table if not exists public.member_loans (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  amount     numeric(14, 2) not null check (amount > 0),
  currency   text not null default 'LKR',
  -- What they asked for it for, in their words.
  reason     text,
  issued_on  date not null default current_date,
  due_on     date,
  status     text not null default 'outstanding'
             check (status in ('outstanding', 'repaid', 'written_off')),
  note       text,
  issued_by  uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.member_loans is
  'Advances paid to a team member. An outstanding loan is subtracted from that member''s commission balance until it is repaid or written off.';
comment on column public.member_loans.status is
  'Maintained by the repayment trigger — outstanding until repayments cover the amount, then repaid. written_off is set by hand and stops the deduction for good.';

create index if not exists member_loans_user_idx
  on public.member_loans (user_id, issued_on desc);

-- The lookup every commission balance makes: what is still owed to us.
create index if not exists member_loans_open_idx
  on public.member_loans (user_id)
  where status = 'outstanding';

-- 2. Repayments ----------------------------------------------
create table if not exists public.member_loan_repayments (
  id          uuid primary key default gen_random_uuid(),
  loan_id     uuid not null references public.member_loans (id) on delete cascade,
  -- Denormalised from the loan (kept true by a trigger) so a member's own
  -- rows can be found — and RLS-checked — without a join.
  user_id     uuid not null references public.profiles (id) on delete cascade,
  amount      numeric(14, 2) not null check (amount > 0),
  paid_on     date not null default current_date,
  method      text,
  note        text,
  recorded_by uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists member_loan_repayments_loan_idx
  on public.member_loan_repayments (loan_id, paid_on desc);
create index if not exists member_loan_repayments_user_idx
  on public.member_loan_repayments (user_id);

-- 3. Keep the loan's status true ------------------------------
-- One place decides whether a loan is settled, so no screen can disagree
-- with another about what a member still owes.
create or replace function public.refresh_member_loan_status(p_loan uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  loan_amount numeric(14, 2);
  loan_status text;
  repaid      numeric(14, 2);
  next_status text;
begin
  select amount, status into loan_amount, loan_status
  from public.member_loans where id = p_loan;
  if not found then return; end if;

  -- Written off is a decision, not a calculation — leave it alone.
  if loan_status = 'written_off' then return; end if;

  select coalesce(sum(amount), 0) into repaid
  from public.member_loan_repayments where loan_id = p_loan;

  next_status := case when repaid >= loan_amount then 'repaid' else 'outstanding' end;

  if next_status is distinct from loan_status then
    update public.member_loans set status = next_status where id = p_loan;
  end if;
end $$;

-- Repayment added / corrected / removed.
create or replace function public.member_loan_repayment_synced()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.refresh_member_loan_status(old.loan_id);
    return old;
  end if;
  perform public.refresh_member_loan_status(new.loan_id);
  -- A repayment moved to a different loan settles the old one too.
  if tg_op = 'UPDATE' and old.loan_id is distinct from new.loan_id then
    perform public.refresh_member_loan_status(old.loan_id);
  end if;
  return new;
end $$;

drop trigger if exists member_loan_repayments_sync on public.member_loan_repayments;
create trigger member_loan_repayments_sync
  after insert or update or delete on public.member_loan_repayments
  for each row execute function public.member_loan_repayment_synced();

-- The repayment always belongs to whoever the loan belongs to.
create or replace function public.member_loan_repayment_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select user_id into new.user_id from public.member_loans where id = new.loan_id;
  return new;
end $$;

drop trigger if exists member_loan_repayments_owner on public.member_loan_repayments;
create trigger member_loan_repayments_owner
  before insert or update of loan_id on public.member_loan_repayments
  for each row execute function public.member_loan_repayment_owner();

-- The loan's own amount changed — what was settled may not be any more.
-- The WHEN clause keeps the status-only write above from re-firing this.
create or replace function public.member_loan_amount_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.refresh_member_loan_status(new.id);
  return new;
end $$;

drop trigger if exists member_loans_amount_sync on public.member_loans;
create trigger member_loans_amount_sync
  after update of amount on public.member_loans
  for each row
  when (old.amount is distinct from new.amount)
  execute function public.member_loan_amount_changed();

-- Keep updated_at honest (generic touch function from 0001).
drop trigger if exists member_loans_set_updated_at on public.member_loans;
create trigger member_loans_set_updated_at
  before update on public.member_loans
  for each row execute function public.set_updated_at();

-- 4. Row level security --------------------------------------
-- Same shape as commissions (0006): your own money is yours to see,
-- everyone's money is the admin's to see, and only an admin moves it.
alter table public.member_loans enable row level security;
alter table public.member_loan_repayments enable row level security;

drop policy if exists "member_loans: read own or admin" on public.member_loans;
create policy "member_loans: read own or admin" on public.member_loans
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists "member_loans: admin insert" on public.member_loans;
create policy "member_loans: admin insert" on public.member_loans
  for insert to authenticated
  with check (public.is_admin(auth.uid()));

drop policy if exists "member_loans: admin update" on public.member_loans;
create policy "member_loans: admin update" on public.member_loans
  for update to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

drop policy if exists "member_loans: admin delete" on public.member_loans;
create policy "member_loans: admin delete" on public.member_loans
  for delete to authenticated
  using (public.is_admin(auth.uid()));

drop policy if exists "member_loan_repayments: read own or admin"
  on public.member_loan_repayments;
create policy "member_loan_repayments: read own or admin"
  on public.member_loan_repayments
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists "member_loan_repayments: admin insert"
  on public.member_loan_repayments;
create policy "member_loan_repayments: admin insert"
  on public.member_loan_repayments
  for insert to authenticated
  with check (public.is_admin(auth.uid()));

drop policy if exists "member_loan_repayments: admin update"
  on public.member_loan_repayments;
create policy "member_loan_repayments: admin update"
  on public.member_loan_repayments
  for update to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

drop policy if exists "member_loan_repayments: admin delete"
  on public.member_loan_repayments;
create policy "member_loan_repayments: admin delete"
  on public.member_loan_repayments
  for delete to authenticated
  using (public.is_admin(auth.uid()));

-- 5. Realtime (0021 guard pattern) ---------------------------
-- A repayment recorded on the member's page must move the balance on the
-- Team board without anyone reloading.
do $$
declare
  t text;
begin
  foreach t in array array['member_loans', 'member_loan_repayments'] loop
    begin
      execute format(
        'alter publication supabase_realtime add table public.%I', t
      );
    exception
      when duplicate_object then null; -- already published
      when others then null;           -- e.g. publication is FOR ALL TABLES
    end;
  end loop;
end $$;

-- 6. Member-change audit (0081 pattern) ----------------------
-- Money moving between the company and a member is exactly what the
-- Changes trail is for. Service-role writes stay unlogged, by design.
do $$
declare
  t text;
begin
  if to_regclass('public.member_changes') is null then return; end if;
  foreach t in array array['member_loans', 'member_loan_repayments'] loop
    execute format('drop trigger if exists member_changes_audit on public.%I', t);
    execute format(
      'create trigger member_changes_audit
         after insert or update or delete on public.%I
         for each row execute function public.log_member_change()',
      t
    );
  end loop;
end $$;
