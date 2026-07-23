-- ============================================================
-- 0061_invoices_bank_account.sql
-- Which bank account an invoice asks to be paid into. Matches an
-- id from INVOICE_BANKS in src/lib/invoice.ts ('commercial' or
-- 'nations-trust'). Null/empty = the default (first) account, so
-- every invoice saved before the picker existed keeps printing
-- exactly the details it was issued with.
-- ============================================================

alter table public.invoices
  add column if not exists bank_account text;
