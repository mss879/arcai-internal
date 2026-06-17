-- ============================================================
-- 0017_company_payments_is_paid.sql
-- Add is_paid column to company_payments table if not exists.
-- ============================================================

alter table public.company_payments 
  add column if not exists is_paid boolean not null default false;
