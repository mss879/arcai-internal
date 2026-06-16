-- ============================================================
-- 0014_crm_currency_lkr.sql
-- Change default currency from USD to LKR.
-- ============================================================

-- Update defaults
alter table public.leads alter column currency set default 'LKR';
alter table public.projects alter column currency set default 'LKR';
alter table public.payments alter column currency set default 'LKR';

-- Update existing data
update public.leads set currency = 'LKR' where currency = 'USD';
update public.projects set currency = 'LKR' where currency = 'USD';
update public.payments set currency = 'LKR' where currency = 'USD';
