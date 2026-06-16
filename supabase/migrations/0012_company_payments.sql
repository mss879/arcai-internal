-- ============================================================
-- 0012_company_payments.sql
-- Database schema for shared company payments directory in LKR.
-- ============================================================

create table if not exists public.company_payments (
  id           uuid primary key default gen_random_uuid(),
  company_name text not null,
  price_lkr    numeric(15, 2) not null check (price_lkr >= 0),
  created_by   uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now()
);

create index if not exists company_payments_created_at_idx on public.company_payments (created_at desc);

alter table public.company_payments enable row level security;

create policy "company_payments: read all"
  on public.company_payments for select to authenticated using (true);

create policy "company_payments: write all"
  on public.company_payments for insert to authenticated with check (true);

create policy "company_payments: update all"
  on public.company_payments for update to authenticated using (true) with check (true);

create policy "company_payments: delete all"
  on public.company_payments for delete to authenticated using (true);
