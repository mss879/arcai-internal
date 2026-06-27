-- ============================================================
-- 0024_invoices_stamp.sql
-- Optional "paid" rubber stamp printed over an invoice's totals.
-- Empty/null = no stamp; 'deposit_paid' once the deposit is settled,
-- 'payment_received' once the invoice is paid in full. The generator
-- stamps the saved copy best-effort, so this column is optional.
-- ============================================================

alter table public.invoices
  add column if not exists stamp text;
