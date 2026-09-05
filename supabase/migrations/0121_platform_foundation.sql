-- ============================================================
-- 0121_platform_foundation.sql
-- ============================================================
-- Track 5 of the next wave, plus the one Track 4 leftover that needs SQL.
-- Additive only: no backfill, no data rewritten. Safe to run against the
-- live build before the code that reads it is deployed.
--
-- Sections:
--   1. Commission payouts write the company ledger under their own category.
--      (T4.7 — `expenses.category` gains 'commission'.)
--
-- Widening a CHECK is drop + add, never a do-$$ block that swallows a
-- duplicate_object and leaves the OLD constraint in place. The new list
-- repeats every value 0033 allowed — a widening REPLACES the constraint.
-- ============================================================

-- 1. Commission payouts ------------------------------------------------------

alter table public.expenses drop constraint if exists expenses_category_check;
alter table public.expenses add constraint expenses_category_check
  check (category in (
    'salaries', 'rent', 'software', 'ads', 'hosting',
    'equipment', 'transport', 'utilities', 'fees', 'other',
    -- 0121 — a payout run's expenses row (src/app/(app)/team/[id]/actions.ts)
    'commission'
  ));
