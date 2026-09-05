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

-- 3. System write audit (T5.3) --------------------------------------------
-- member_changes (0081) records what a PERSON changed, by trigger. Nothing
-- recorded what the system did on its own: an invoice the tick raised, a
-- post published to Instagram, a review put on the website, a slip filed
-- from a WhatsApp photo, a payout run. system_events is that record, written
-- by src/lib/system-audit.ts logSystemWrite() from each of those cores.

create table if not exists public.system_events (
  id         uuid primary key default gen_random_uuid(),
  -- The job or core that wrote: 'recurringIncome', 'socialPublish', 'payout'…
  job        text not null,
  -- system:<job> | assistant | automation:<id> | user:<uuid>
  actor      text not null,
  table_name text not null,
  row_id     text,
  action     text not null
             check (action in ('created', 'updated', 'deleted', 'sent', 'published', 'unpublished')),
  summary    text not null,
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists system_events_created_idx
  on public.system_events (created_at desc);
create index if not exists system_events_row_idx
  on public.system_events (table_name, row_id);

alter table public.system_events enable row level security;

-- Admins read it (the Team page); any signed-in writer may append — the
-- cores run under a person's client from a server action as often as under
-- the service role from the tick. Nobody updates or deletes a line.
do $$
begin
  create policy system_events_admin_read on public.system_events
    for select using (public.is_admin(auth.uid()));
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create policy system_events_append on public.system_events
    for insert with check (auth.uid() is not null);
exception
  when duplicate_object then null;
end $$;

-- 4. Error tracking (T5.5) ---------------------------------------------------
-- One row per DISTINCT failure (fingerprint = source + normalised message +
-- first stack frame), counted up rather than logged again, so a tick that
-- fails every five minutes is one row with a count, not 288 rows a day.
-- Written by src/lib/errors.ts captureError(); read on /settings.

create table if not exists public.error_events (
  id               uuid primary key default gen_random_uuid(),
  fingerprint      text not null unique,
  -- tick | assistant-tick | wa-tick | route | client | server
  source           text not null,
  message          text not null,
  stack            text,
  path             text,
  count            int  not null default 1,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  last_notified_at timestamptz,
  resolved_at      timestamptz,
  meta             jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists error_events_last_seen_idx
  on public.error_events (last_seen_at desc);
create index if not exists error_events_open_idx
  on public.error_events (resolved_at) where resolved_at is null;

alter table public.error_events enable row level security;

-- Admins read and resolve; the writer is captureError() through the
-- service role (a tick has no session), so no insert policy is needed.
do $$
begin
  create policy error_events_admin_read on public.error_events
    for select using (public.is_admin(auth.uid()));
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create policy error_events_admin_resolve on public.error_events
    for update using (public.is_admin(auth.uid()));
exception
  when duplicate_object then null;
end $$;
