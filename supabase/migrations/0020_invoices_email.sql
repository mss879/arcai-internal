-- ============================================================
-- 0020_invoices_email.sql
-- Track when a saved invoice was emailed (via the voice assistant
-- or the Past invoices tab) and to whom. Both columns are optional;
-- the send flow stamps them best-effort after a successful send.
-- ============================================================

alter table public.invoices
  add column if not exists recipient_email text,
  add column if not exists sent_at         timestamptz;
