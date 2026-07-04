-- ============================================================
-- 0031_sales.sql
-- "Close more deals" layer:
--
--   leads gains deal fields  : open/won/lost, expected close date,
--                              probability (forecast), hot/warm/cold
--                              AI score + AI summary / next action
--   pipelines.stale_after_days : stale-deal alert threshold
--   quotes                   : quotation builder with public share
--                              link + e-signature; converts to invoice
-- ============================================================

-- ---- Deal fields on leads -----------------------------------
alter table public.leads add column if not exists status text not null default 'open'
  check (status in ('open', 'won', 'lost'));
alter table public.leads add column if not exists won_at timestamptz;
alter table public.leads add column if not exists lost_at timestamptz;
alter table public.leads add column if not exists lost_reason text;
alter table public.leads add column if not exists expected_close_date date;
alter table public.leads add column if not exists probability integer
  check (probability between 0 and 100);
alter table public.leads add column if not exists score text
  check (score in ('hot', 'warm', 'cold'));
alter table public.leads add column if not exists score_reason text;
alter table public.leads add column if not exists ai_summary text;
alter table public.leads add column if not exists ai_next_action text;

create index if not exists leads_status_idx on public.leads (status);
create index if not exists leads_close_date_idx on public.leads (expected_close_date);

-- Days a deal may sit untouched before it's flagged stale.
alter table public.pipelines add column if not exists stale_after_days integer not null default 7;

-- ---- Quotes -------------------------------------------------
create table if not exists public.quotes (
  id              uuid primary key default gen_random_uuid(),
  quote_number    text not null,
  title           text not null default '',
  -- Who it's for. Free-text name plus optional links back into the CRM.
  customer_name   text not null default '',
  customer_email  text,
  customer_phone  text,
  lead_id         uuid references public.leads (id) on delete set null,
  client_id       uuid references public.clients (id) on delete set null,
  -- Line items, same shape as invoices.items:
  -- [{ item, description, qty, rate, total }]
  items           jsonb not null default '[]',
  subtotal        numeric(14, 2) not null default 0,
  discount        numeric(14, 2) not null default 0,
  tax_rate        numeric(5, 2) not null default 0,
  tax_amount      numeric(14, 2) not null default 0,
  grand_total     numeric(14, 2) not null default 0,
  currency        text not null default 'LKR',
  valid_until     date,
  notes           text,
  terms           text,
  status          text not null default 'draft'
                  check (status in ('draft', 'sent', 'viewed', 'accepted', 'declined', 'expired')),
  -- Public acceptance link: /q/<share_token>
  share_token     text not null unique
                  default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  sent_at         timestamptz,
  viewed_at       timestamptz,
  -- E-signature captured on acceptance.
  signed_name     text,
  signature_data  text,
  signed_ip       text,
  accepted_at     timestamptz,
  declined_at     timestamptz,
  declined_reason text,
  -- Set when the accepted quote is converted into an invoice.
  invoice_id      uuid references public.invoices (id) on delete set null,
  created_by      uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists quotes_created_idx on public.quotes (created_at desc);
create index if not exists quotes_status_idx on public.quotes (status);
create index if not exists quotes_token_idx on public.quotes (share_token);

drop trigger if exists quotes_set_updated_at on public.quotes;
create trigger quotes_set_updated_at
  before update on public.quotes
  for each row execute function public.set_updated_at();

-- Log quote lifecycle onto the linked lead's timeline.
create or replace function public.log_quote_activity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.lead_id is null then return new; end if;
  if tg_op = 'INSERT' then
    insert into public.lead_activities (lead_id, kind, title, meta, actor_id)
    values (new.lead_id, 'quote', 'Quote ' || new.quote_number || ' created',
            jsonb_build_object('quote_id', new.id, 'total', new.grand_total), new.created_by);
  elsif new.status is distinct from old.status then
    insert into public.lead_activities (lead_id, kind, title, meta)
    values (new.lead_id, 'quote', 'Quote ' || new.quote_number || ' ' || new.status,
            jsonb_build_object('quote_id', new.id, 'status', new.status));
  end if;
  return new;
end;
$$;

drop trigger if exists quotes_log_activity on public.quotes;
create trigger quotes_log_activity
  after insert or update on public.quotes
  for each row execute function public.log_quote_activity();

-- ---- RLS + realtime -----------------------------------------
do $$
declare t text;
begin
  foreach t in array array['quotes'] loop
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
