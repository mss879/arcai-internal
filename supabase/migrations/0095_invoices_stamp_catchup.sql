-- ============================================================
-- 0095_invoices_stamp_catchup.sql
--
-- Re-applies 0024. That migration was never run on the live
-- database — `invoices.stamp` is genuinely absent there, which
-- was invisible until now because the only writer
-- (saveInvoice) sets the stamp in a separate best-effort
-- UPDATE that is allowed to fail silently.
--
-- 0093 made it matter: the deposit-confirmation invoice is
-- defined by carrying the DEPOSIT PAID stamp, and the public
-- invoice page reads the column to decide which rubber stamp
-- to print. Without it the client's invoice link 404s.
--
-- The 0093 code paths are written to survive the column being
-- missing (they degrade to an unstamped invoice rather than no
-- invoice), but the stamp is the point of the feature — so the
-- column needs to exist.
--
-- Identical to 0024 and safe to run whether or not that one
-- was ever applied.
-- ============================================================

alter table public.invoices
  add column if not exists stamp text;

comment on column public.invoices.stamp is
  'Optional rubber stamp printed over the invoice totals: ''deposit_paid'' once the deposit is settled, ''payment_received'' once it is paid in full. NULL = no stamp.';
