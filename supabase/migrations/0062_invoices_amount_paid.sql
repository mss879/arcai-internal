-- ============================================================
-- 0062_invoices_amount_paid.sql
-- How much the client has already paid toward this invoice. Shown
-- in red on the invoice and subtracted from the total to give the
-- amount still due. Null/absent = nothing paid yet, so every invoice
-- saved before this column existed keeps printing exactly as before.
-- ============================================================

alter table public.invoices
  add column if not exists amount_paid numeric;
