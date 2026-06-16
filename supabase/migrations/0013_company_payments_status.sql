-- ============================================================
-- 0013_company_payments_status.sql
-- Add status column to company_payments table.
-- ============================================================

alter table public.company_payments 
  add column if not exists status text not null default 'pending' 
  check (status in ('pending', 'upcoming')),
  add column if not exists is_paid boolean not null default false;
