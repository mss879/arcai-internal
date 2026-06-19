-- ============================================================
-- 0019_invoices.sql
-- Persisted invoices. Every invoice the generator downloads is
-- saved here so it shows up under the "Past invoices" tab.
-- Shared across the workspace, mirroring company_payments (0012).
-- ============================================================

create table if not exists public.invoices (
  id              uuid primary key default gen_random_uuid(),
  invoice_number  text not null,
  invoice_date    date not null,
  bill_to_name    text not null default '',
  bill_to_details text not null default '',
  -- Snapshot of the printed line items:
  -- [{ "item", "description", "qty", "rate", "total" }]
  items           jsonb not null default '[]'::jsonb,
  grand_total     numeric(15, 2) not null default 0 check (grand_total >= 0),
  due_today       numeric(15, 2) not null default 0 check (due_today >= 0),
  created_by      uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at      timestamptz not null default now()
);

create index if not exists invoices_created_at_idx on public.invoices (created_at desc);

alter table public.invoices enable row level security;

create policy "invoices: read all"
  on public.invoices for select to authenticated using (true);

create policy "invoices: write all"
  on public.invoices for insert to authenticated with check (true);

create policy "invoices: update all"
  on public.invoices for update to authenticated using (true) with check (true);

create policy "invoices: delete all"
  on public.invoices for delete to authenticated using (true);

-- Live updates for the "Past invoices" tab (optional). Ignored if the
-- realtime publication is FOR ALL TABLES or already includes this table.
do $$
begin
  alter publication supabase_realtime add table public.invoices;
exception
  when others then null;
end $$;
