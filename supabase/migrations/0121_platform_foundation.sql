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

-- 2. Capabilities (T5.2) -----------------------------------------------------
-- Which areas a member may work in. An admin has every capability by
-- role; the column matters for members only. Read by src/lib/capabilities.ts
-- (nav, page guards) and src/lib/capabilities-server.ts (money actions,
-- finance notifications). RLS stays USING (true) — this is "RLS-lite", see
-- docs/ops.md: the app enforces, the database records.

alter table public.profiles
  add column if not exists capabilities text[] not null default '{}'::text[];

-- A brand-new named constraint, so the do-$$ form is the right one here.
do $$
begin
  alter table public.profiles
    add constraint profiles_capabilities_check
    check (capabilities <@ array['finance', 'delivery', 'sales', 'marketing']::text[]);
exception
  when duplicate_object then null;
end $$;

comment on column public.profiles.capabilities is
  'finance | delivery | sales | marketing. Members only — an admin has all four by role. Enforced by the app only when app_settings.capabilities_enforced.enabled is true; until then it drives the sidebar alone.';

-- Members start with everything, so the day this lands nothing changes for
-- anyone. Idempotent: only rows that have no capabilities yet are touched.
update public.profiles
   set capabilities = array['finance', 'delivery', 'sales', 'marketing']
 where role = 'member'
   and coalesce(array_length(capabilities, 1), 0) = 0;

-- Enforcement is a switch on /settings; off until an admin turns it on.
insert into public.app_settings (key, value)
values ('capabilities_enforced', '{"enabled": false}'::jsonb)
on conflict (key) do nothing;
