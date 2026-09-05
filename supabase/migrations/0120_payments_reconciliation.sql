-- ============================================================
-- 0120_payments_reconciliation.sql
-- ============================================================
-- Track 4 of the next wave: get paid faster.
--
-- The only migration in this wave that BACKFILLS. Run it on a branch
-- database first. Pre-checks — run these before applying and keep the
-- numbers; the notices the DO blocks raise should agree with them:
--
--   -- invoices that will read 'paid' after the backfill
--   select count(*) from public.invoices where stamp = 'payment_received';
--   -- invoices that will read 'partially_paid'
--   select count(*) from public.invoices
--    where stamp = 'deposit_paid' or coalesce(amount_paid, 0) > 0;
--   -- duplicate invoice numbers the re-stamp bug created (kept as re-issues)
--   select invoice_number, count(*) from public.invoices
--    group by invoice_number having count(*) > 1;
--   -- duplicate quote / notice numbers (the partial unique index is skipped
--   -- with a notice if any exist; fix them by hand, then re-run)
--   select quote_number, count(*) from public.quotes
--    group by quote_number having count(*) > 1;
--   select notice_number, count(*) from public.notices
--    group by notice_number having count(*) > 1;
--
-- What this fixes:
--
--   1. "Paid" was a stamp image. `invoices.status`, `paid_amount`, `paid_at`
--      and `due_date` make it a state, backfilled from the stamp and the
--      legacy `amount_paid` snapshot. `reissued_from_id` + `voided_at` split
--      "fix this invoice" from "raise a new one".
--   2. Five screens wrote payments and none touched an invoice. `payments`
--      gains `invoice_id` / `installment_id` / `slip_id` / `source`, and
--      `project_id` becomes optional so money against a standalone invoice
--      has somewhere to live. recordPayment() (src/lib/payments.ts) is the
--      one writer; reconcileInvoice() (src/lib/invoices.ts) the one reader.
--   3. The client's bank-transfer slip becomes the "pay" button:
--      `payment_slips` + the private `payment-slips` bucket.
--   4. Recurring income can raise its own invoice and remind.
--   5. Commission payouts are a record, not a status flip.
--   6. Five numbering rules and no constraint: `document_counters` +
--      next_document_number(kind), duplicates marked as re-issues, and a
--      partial unique index on the live rows of each series.
--
-- Additive and idempotent. Apply BEFORE pushing the code that reads these.
-- ============================================================

-- 1. Invoices become a state ---------------------------------------------

alter table public.invoices
  add column if not exists status          text not null default 'issued',
  add column if not exists paid_amount     numeric(15, 2) not null default 0,
  add column if not exists paid_at         timestamptz,
  add column if not exists due_date        date,
  add column if not exists voided_at       timestamptz,
  add column if not exists void_reason     text,
  -- The invoice this one replaces. Set by reissueInvoice(), and by the
  -- duplicate-number pass below for the rows the re-stamp bug created.
  add column if not exists reissued_from_id uuid references public.invoices (id) on delete set null;

-- Widening is drop-then-add (a do-$$ block would swallow the failure).
alter table public.invoices drop constraint if exists invoices_status_check;
alter table public.invoices add constraint invoices_status_check
  check (status in ('issued', 'sent', 'partially_paid', 'paid', 'void'));

create index if not exists invoices_status_idx
  on public.invoices (status)
  where status in ('issued', 'sent', 'partially_paid');
create index if not exists invoices_due_idx
  on public.invoices (due_date)
  where due_date is not null and status in ('issued', 'sent', 'partially_paid');

comment on column public.invoices.status is
  'issued → sent → partially_paid → paid, or void. Written ONLY by reconcileInvoice() / voidInvoice() in src/lib/invoices.ts.';
comment on column public.invoices.paid_amount is
  'Sum of the payments linked to this invoice (or the legacy amount_paid snapshot when nothing is linked). Written only by reconcileInvoice().';

-- Backfill, once: only rows still at the column defaults are touched, so
-- re-running is a no-op for anything already reconciled.
do $$
declare
  v_paid int := 0;
  v_partial int := 0;
  v_sent int := 0;
begin
  -- Settled in full: the PAYMENT RECEIVED stamp.
  update public.invoices
     set status = 'paid',
         paid_amount = grand_total,
         paid_at = coalesce(paid_at, created_at)
   where status = 'issued' and paid_amount = 0 and paid_at is null
     and stamp = 'payment_received';
  get diagnostics v_paid = row_count;

  -- Part-paid: the DEPOSIT PAID stamp, or a recorded amount_paid.
  update public.invoices
     set status = case when coalesce(amount_paid, 0) >= grand_total and grand_total > 0
                       then 'paid' else 'partially_paid' end,
         paid_amount = coalesce(amount_paid, 0),
         paid_at = coalesce(paid_at, created_at)
   where status = 'issued' and paid_amount = 0 and paid_at is null
     and (stamp = 'deposit_paid' or coalesce(amount_paid, 0) > 0);
  get diagnostics v_partial = row_count;

  -- Sent, nothing paid.
  update public.invoices
     set status = 'sent'
   where status = 'issued' and paid_amount = 0 and paid_at is null
     and (sent_at is not null or shared_at is not null);
  get diagnostics v_sent = row_count;

  raise notice '0120 invoices backfilled: % paid, % part-paid, % sent', v_paid, v_partial, v_sent;
end $$;

-- 2. Payments know what they settle ---------------------------------------

alter table public.payments
  add column if not exists invoice_id      uuid references public.invoices (id) on delete set null,
  add column if not exists installment_id  uuid references public.payment_installments (id) on delete set null,
  -- FK added after payment_slips exists, below.
  add column if not exists slip_id         uuid,
  -- Which door the money came in through.
  add column if not exists source          text not null default 'team',
  -- A gateway's transaction id, when one day there is a gateway.
  add column if not exists provider_ref    text;

alter table public.payments drop constraint if exists payments_source_check;
alter table public.payments add constraint payments_source_check
  check (source in ('team', 'project_detail', 'payments_board', 'finance', 'deposit',
                    'assistant', 'slip', 'whatsapp', 'recurring', 'gateway',
                    'automation', 'import'));

-- Money against a standalone invoice (no project) needs a row too. The
-- project link stays the normal case; a payment must still point at
-- SOMETHING — a project, an invoice or an instalment.
alter table public.payments alter column project_id drop not null;
do $$
begin
  alter table public.payments add constraint payments_settles_something_check
    check (project_id is not null or invoice_id is not null or installment_id is not null);
exception when duplicate_object then null;
end $$;

create index if not exists payments_invoice_idx
  on public.payments (invoice_id) where invoice_id is not null;
create index if not exists payments_installment_idx
  on public.payments (installment_id) where installment_id is not null;

alter table public.company_payments
  add column if not exists invoice_id uuid references public.invoices (id) on delete set null;
alter table public.payment_installments
  add column if not exists invoice_id uuid references public.invoices (id) on delete set null;

create index if not exists company_payments_invoice_idx
  on public.company_payments (invoice_id) where invoice_id is not null;
create index if not exists payment_installments_invoice_idx
  on public.payment_installments (invoice_id) where invoice_id is not null;

-- A payment landing is worth a line on the project's History.
alter table public.delivery_events drop constraint if exists delivery_events_kind_check;
alter table public.delivery_events add constraint delivery_events_kind_check check (kind in (
  -- 0084
  'kickoff', 'stage_changed', 'asset_submitted', 'asset_filed', 'asset_na',
  'chase_sent', 'stalled_alert', 'assets_complete', 'milestone_sent',
  -- 0094
  'portal_sent', 'portal_unlocked', 'portal_locked', 'review_requested',
  'review_received', 'approval_requested', 'approval_signed',
  'change_requested', 'change_accepted', 'comment', 'pulse', 'handover_sent',
  -- 0112
  'client_note', 'site_launched',
  -- 0120
  'payment_received'
));

-- 3. The bank-transfer slip -------------------------------------------------

create table if not exists public.payment_slips (
  id               uuid primary key default gen_random_uuid(),
  source           text not null
                   check (source in ('public_invoice', 'portal', 'whatsapp', 'team', 'gateway')),
  invoice_id       uuid references public.invoices (id)     on delete set null,
  project_id       uuid references public.projects (id)     on delete set null,
  client_id        uuid references public.clients (id)      on delete set null,
  wa_contact_id    uuid references public.wa_contacts (id)  on delete set null,
  wa_message_id    uuid references public.wa_messages (id)  on delete set null,
  /* Path inside the private payment-slips bucket (or wa-media for WhatsApp). */
  file_path        text not null,
  bucket           text not null default 'payment-slips',
  mime             text,
  size_bytes       bigint,
  -- What the reader made of it: { amount, currency, reference, bank, date, payer }.
  parsed           jsonb not null default '{}'::jsonb,
  amount_claimed   numeric(15, 2),
  reference        text,
  note             text,
  status           text not null default 'pending'
                   check (status in ('pending', 'verified', 'rejected', 'duplicate')),
  -- How the parsed amount compares with what the invoice still owes.
  match            text not null default 'unknown'
                   check (match in ('exact', 'partial', 'mismatch', 'unknown')),
  decided_by       uuid references public.profiles (id) on delete set null,
  decided_at       timestamptz,
  rejection_reason text,
  -- The payment this slip became, once verified.
  payment_id       uuid references public.payments (id) on delete set null,
  ip               text,
  created_at       timestamptz not null default now()
);

create index if not exists payment_slips_status_idx
  on public.payment_slips (status, created_at desc);
create index if not exists payment_slips_invoice_idx
  on public.payment_slips (invoice_id) where invoice_id is not null;

do $$
begin
  alter table public.payments
    add constraint payments_slip_id_fkey
    foreign key (slip_id) references public.payment_slips (id) on delete set null;
exception when duplicate_object then null;
end $$;

-- Private: a slip is a picture of somebody's bank account. Signed URLs only.
insert into storage.buckets (id, name, public)
values ('payment-slips', 'payment-slips', false)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'storage: auth read payment-slips'
  ) then
    create policy "storage: auth read payment-slips"
      on storage.objects for select to authenticated
      using (bucket_id = 'payment-slips');
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'storage: auth insert payment-slips'
  ) then
    create policy "storage: auth insert payment-slips"
      on storage.objects for insert to authenticated
      with check (bucket_id = 'payment-slips');
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'storage: auth delete payment-slips'
  ) then
    create policy "storage: auth delete payment-slips"
      on storage.objects for delete to authenticated
      using (bucket_id = 'payment-slips');
  end if;
end $$;
-- The public invoice page and the portal upload through the service-role
-- client, which bypasses these policies; nothing anonymous touches the bucket.

-- 4. Recurring income can bill -------------------------------------------

alter table public.recurring_income
  add column if not exists auto_invoice boolean not null default false,
  add column if not exists remind       boolean not null default false,
  -- The line item to print: { item, description }. Null = the label.
  add column if not exists invoice_item jsonb;

alter table public.recurring_income_entries
  add column if not exists invoice_id          uuid references public.invoices (id) on delete set null,
  add column if not exists reminded_at         timestamptz,
  add column if not exists overdue_reminded_at timestamptz;

-- One active retainer per project. Guarded: existing data may already hold
-- two, and that is a fact to fix by hand, not a reason to fail the migration.
do $$
begin
  create unique index recurring_income_retainer_project_key
    on public.recurring_income (project_id)
    where project_id is not null and category = 'retainer' and is_active;
exception
  when duplicate_table then null;
  when unique_violation then
    raise notice '0120: a project has two active retainers — recurring_income_retainer_project_key NOT created. Deactivate one and re-run this statement.';
end $$;

-- 5. Commission payouts ------------------------------------------------------

create table if not exists public.commission_payouts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  -- The month the run covers; the payout may include older accruals.
  period         date not null,
  gross          numeric(14, 2) not null default 0,
  loan_deduction numeric(14, 2) not null default 0,
  net_paid       numeric(14, 2) not null default 0,
  method         text,
  reference      text,
  note           text,
  paid_at        timestamptz not null default now(),
  paid_by        uuid references public.profiles (id) on delete set null,
  -- The expenses row the run wrote, so the company ledger and this agree.
  expense_id     uuid references public.expenses (id) on delete set null,
  created_at     timestamptz not null default now()
);

create index if not exists commission_payouts_user_idx
  on public.commission_payouts (user_id, paid_at desc);

alter table public.commissions
  add column if not exists payout_id uuid references public.commission_payouts (id) on delete set null;
alter table public.member_loan_repayments
  add column if not exists payout_id uuid references public.commission_payouts (id) on delete set null;

-- 6. Document numbering -------------------------------------------------------

create table if not exists public.document_counters (
  kind       text primary key,
  prefix     text not null default '',
  width      int  not null default 5,
  suffix     text not null default '',
  -- The last number handed out. next_document_number() increments it under
  -- the row lock an UPDATE takes, so two concurrent saves never share one.
  last       int  not null default 0,
  -- Quotes are Q-<year>-NNN: the year is part of the prefix and the count
  -- starts again each January.
  yearly     boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.document_counters enable row level security;
-- No policies on purpose: only next_document_number() (security definer)
-- touches this table, and the seeds below run as the migration.

-- Seed each series from the highest number already on file, so the first
-- number after this migration continues the sequence rather than restarting.
do $$
declare
  v_row record;
begin
  -- invoices: "#00204" → prefix '#', width 5, last 204
  if not exists (select 1 from public.document_counters where kind = 'invoice') then
    select substring(invoice_number from '^(.*?)\d') as prefix,
           length(substring(invoice_number from '\d+')) as width,
           substring(invoice_number from '\d+')::int as last
      into v_row
      from public.invoices
     where invoice_number ~ '\d'
     order by substring(invoice_number from '\d+')::int desc
     limit 1;
    insert into public.document_counters (kind, prefix, width, last)
    values ('invoice', coalesce(v_row.prefix, '#'), coalesce(v_row.width, 5), coalesce(v_row.last, 199));
  end if;

  -- notices: "#00104" → prefix '#', width 5, last 104
  if not exists (select 1 from public.document_counters where kind = 'notice') then
    select substring(notice_number from '^(.*?)\d') as prefix,
           length(substring(notice_number from '\d+')) as width,
           substring(notice_number from '\d+')::int as last
      into v_row
      from public.notices
     where notice_number ~ '\d'
     order by substring(notice_number from '\d+')::int desc
     limit 1;
    insert into public.document_counters (kind, prefix, width, last)
    values ('notice', coalesce(v_row.prefix, '#'), coalesce(v_row.width, 5), coalesce(v_row.last, 99));
  end if;

  -- quotes: "Q-2026-017" → prefix 'Q-2026-', width 3, last 17, yearly
  if not exists (select 1 from public.document_counters where kind = 'quote') then
    select substring(quote_number from '(\d+)$')::int as last,
           length(substring(quote_number from '(\d+)$')) as width
      into v_row
      from public.quotes
     where quote_number like 'Q-' || extract(year from now())::text || '-%'
       and quote_number ~ '\d+$'
     order by substring(quote_number from '(\d+)$')::int desc
     limit 1;
    insert into public.document_counters (kind, prefix, width, last, yearly)
    values ('quote', 'Q-' || extract(year from now())::text || '-',
            coalesce(v_row.width, 3), coalesce(v_row.last, 0), true);
  end if;
end $$;

/**
 * The next number in a series, under a row lock.
 *
 * security definer, because the callers are team sessions and the automation
 * tick alike, and neither should need write access to the counters table.
 * A yearly series rolls its prefix and count over when the year changes.
 */
create or replace function public.next_document_number(p_kind text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year text := extract(year from now())::text;
  v_prefix text;
  v_width int;
  v_suffix text;
  v_last int;
  v_yearly boolean;
begin
  -- Lock the row for this transaction; concurrent callers queue here.
  select prefix, width, suffix, last, yearly
    into v_prefix, v_width, v_suffix, v_last, v_yearly
    from public.document_counters
   where kind = p_kind
     for update;

  if not found then
    raise exception 'No document counter for kind "%"', p_kind;
  end if;

  if v_yearly and v_prefix !~ ('^Q-' || v_year || '-$') and v_prefix ~ '^Q-\d{4}-$' then
    v_prefix := 'Q-' || v_year || '-';
    v_last := 0;
  end if;

  v_last := v_last + 1;

  update public.document_counters
     set last = v_last, prefix = v_prefix, updated_at = now()
   where kind = p_kind;

  return v_prefix || lpad(v_last::text, v_width, '0') || v_suffix;
end;
$$;

comment on function public.next_document_number(text) is
  'The next invoice / quote / notice number, allocated under a row lock. Called at INSERT by every writer; nextDocumentNumber() in TS is only the form preview.';

grant execute on function public.next_document_number(text) to authenticated, service_role;

-- 7. Duplicates become re-issues, then the live rows go unique --------------

-- The re-stamp bug (saveInvoice always INSERTed) left the same invoice
-- number on two or three rows. The oldest is the original; the rest are
-- re-issues of it, which is what they always were.
do $$
declare
  v_marked int := 0;
begin
  with ranked as (
    select id, invoice_number,
           first_value(id) over (partition by invoice_number order by created_at, id) as original_id,
           row_number()    over (partition by invoice_number order by created_at, id) as rn
      from public.invoices
     where reissued_from_id is null and voided_at is null
  )
  update public.invoices i
     set reissued_from_id = r.original_id
    from ranked r
   where i.id = r.id and r.rn > 1;
  get diagnostics v_marked = row_count;
  raise notice '0120: % duplicate invoice numbers marked as re-issues', v_marked;
end $$;

-- Live rows only: a void or re-issued invoice keeps its number in history.
do $$
begin
  create unique index invoices_number_live_key
    on public.invoices (invoice_number)
    where reissued_from_id is null and voided_at is null;
exception
  when duplicate_table then null;
  when unique_violation then
    raise notice '0120: duplicate live invoice numbers remain — invoices_number_live_key NOT created. Run the pre-check query, resolve by hand, then re-run this statement.';
end $$;

do $$
begin
  create unique index quotes_number_key on public.quotes (quote_number);
exception
  when duplicate_table then null;
  when unique_violation then
    raise notice '0120: duplicate quote numbers exist — quotes_number_key NOT created. Resolve by hand, then re-run this statement.';
end $$;

do $$
begin
  create unique index notices_number_key on public.notices (notice_number);
exception
  when duplicate_table then null;
  when unique_violation then
    raise notice '0120: duplicate notice numbers exist — notices_number_key NOT created. Resolve by hand, then re-run this statement.';
end $$;

-- 7b. The approvals badge counts slips too ------------------------------------
-- Same body as 0119's, plus the new queue. Replacing the function is the
-- honest edit: a count that silently omitted a queue would be a lie.
create or replace function public.approvals_count()
returns int
language sql
stable
security invoker
set search_path = public
as $$
  select
    (select count(*) from public.assistant_approvals where status = 'pending')
  + (select count(*) from public.member_loans where approval = 'pending')
  + (select count(*) from public.commissions where status = 'pending')
  + (select count(*) from public.wa_lessons where status = 'pending')
  + (select count(*) from public.lead_outreach where status = 'ready')
  + (select count(*) from public.project_change_requests
       where status in ('new', 'quoted'))
  + (select count(*) from public.carousel_posts
       where status = 'ready' and chosen_option_id is null)
  -- 0120
  + (select count(*) from public.payment_slips where status in ('pending', 'duplicate'));
$$;

-- 8. RLS ----------------------------------------------------------------------

alter table public.payment_slips      enable row level security;
alter table public.commission_payouts enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['payment_slips', 'commission_payouts'] loop
    begin
      execute format(
        'create policy "%s: read all" on public.%I for select to authenticated using (true)',
        t, t
      );
    exception when duplicate_object then null; end;
    begin
      execute format(
        'create policy "%s: write all" on public.%I for all to authenticated using (true) with check (true)',
        t, t
      );
    exception when duplicate_object then null; end;
  end loop;
end $$;

-- 9. Realtime (0021 guard pattern) --------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['payment_slips'] loop
    begin
      execute format(
        'alter publication supabase_realtime add table public.%I', t
      );
    exception
      when duplicate_object then null;
      when others then null;
    end;
  end loop;
end $$;
