-- ============================================================
-- 0129_access_boundary.sql
-- ============================================================
-- Phase 0 of the Native Build plan: make a role a role, and make the
-- schema knowable.
--
-- Until this file, three things were true of the live database:
--
--   1. `profiles` was updatable by its owner with no column restriction
--      (0002:84-88) and the anon key ships to the browser
--      (src/lib/supabase/client.ts), so a member could run
--      `supabase.from('profiles').update({ role: 'admin' })` from the
--      console. Every requireAdmin() in the app — 141 of them — was
--      downstream of a row the member could rewrite.
--
--   2. `app_settings` was select/insert/update/delete for ANY authenticated
--      user, via the do-$$ loop at 0032:166-191. It holds
--      `capabilities_enforced`, so a member could switch the permission
--      system off. docs/ops.md:11 already claimed this table was admin-only;
--      this file makes that true.
--
--   3. `api_keys` was readable by ANY authenticated user through the same
--      loop, while /automation had no admin guard and
--      src/app/api/public/v1/* authenticates that key and then runs through
--      the SERVICE ROLE. Member -> full RLS bypass in three clicks.
--
-- Additive and idempotent: no business data is rewritten. Safe to run
-- before the code that depends on it is deployed (the app already reads
-- both tables through the service-role client — see the comment at
-- src/app/(app)/settings/page.tsx:6, which asserted this arrangement
-- before the database enforced it).
--
-- Sections:
--   1. profiles — role and capabilities are admin-only, enforced by trigger.
--   2. app_settings — admin-only, replacing the 0032 open policies.
--   3. api_keys — admin-only, replacing the 0032 open policies.
--   4. schema_migrations — an applied-migrations record.
-- ============================================================

-- 1. profiles: privilege columns are admin-only ------------------------------
-- A policy cannot restrict WHICH columns an update touches, so the guard is
-- a trigger. Three ways through it, in order:
--   * no JWT (auth.uid() is null) — the service role, the 0002 signup
--     trigger and any backfill. Unrestricted, as before.
--   * an admin — unrestricted.
--   * anyone else — role and capabilities must not change.
-- Compared through to_jsonb so the function is correct on a database where
-- 0121 (profiles.capabilities) has not been applied: a missing key is
-- simply absent on both sides and compares equal.

create or replace function public.profiles_guard_privileges()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if public.is_admin(auth.uid()) then
    return new;
  end if;

  if to_jsonb(new) -> 'role' is distinct from to_jsonb(old) -> 'role' then
    raise exception 'Only an admin can change a role.'
      using errcode = '42501';
  end if;

  if to_jsonb(new) -> 'capabilities'
     is distinct from to_jsonb(old) -> 'capabilities' then
    raise exception 'Only an admin can change capabilities.'
      using errcode = '42501';
  end if;

  return new;
end
$$;

drop trigger if exists profiles_guard_privileges on public.profiles;
create trigger profiles_guard_privileges
  before update on public.profiles
  for each row execute function public.profiles_guard_privileges();

-- 2. app_settings: admin-only ------------------------------------------------
-- The four policy names below are exactly what the 0032 loop generated
-- (format('%s: read all', t) and friends). Dropped by name, then replaced.
-- Every reader in the app already uses the service-role client, which does
-- not consult RLS: src/lib/capabilities-server.ts:24, the four tick routes,
-- src/app/(app)/settings/{page,actions}.ts, and the public form/hook routes
-- (all createAdminClient). No realtime channel subscribes to this table.

drop policy if exists "app_settings: read all"   on public.app_settings;
drop policy if exists "app_settings: insert all" on public.app_settings;
drop policy if exists "app_settings: update all" on public.app_settings;
drop policy if exists "app_settings: delete all" on public.app_settings;

do $$
begin
  create policy app_settings_admin_all on public.app_settings
    for all
    using (public.is_admin(auth.uid()))
    with check (public.is_admin(auth.uid()));
exception
  when duplicate_object then null;
end $$;

-- 3. api_keys: admin-only ----------------------------------------------------
-- Same four generated names. The key column stays plaintext for now so
-- existing integrations keep working; hashing it (key_hash + key_prefix,
-- shown once on issue) is a follow-up, and is defence against a database
-- leak rather than against a member — this policy closes the member path.
-- Reads that must keep working: src/app/api/public/v1/{leads,projects}
-- authenticate through createAdminClient (service role, no RLS), and
-- /automation + /settings are admin surfaces.

drop policy if exists "api_keys: read all"   on public.api_keys;
drop policy if exists "api_keys: insert all" on public.api_keys;
drop policy if exists "api_keys: update all" on public.api_keys;
drop policy if exists "api_keys: delete all" on public.api_keys;

do $$
begin
  create policy api_keys_admin_all on public.api_keys
    for all
    using (public.is_admin(auth.uid()))
    with check (public.is_admin(auth.uid()));
exception
  when duplicate_object then null;
end $$;

-- 4. schema_migrations: what has actually been applied -----------------------
-- 0025_content_studio and 0060_notices were never applied and nobody noticed
-- for ~60 migrations, because 0081's audit-trigger loop skips a missing
-- table silently and database.types.ts is hand-written. From 0129 every
-- migration stamps itself here, and scripts/schema-audit.mjs diffs the
-- expected objects against information_schema so a gap is a failing command
-- rather than an empty screen.
--
-- 0001-0127 are NOT backfilled by this file: writing them would assert an
-- apply history nobody can verify. Record them deliberately with
--   node scripts/schema-audit.mjs --record-baseline
-- once the audit reports a clean schema.

create table if not exists public.schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now(),
  note       text
);

alter table public.schema_migrations enable row level security;

do $$
begin
  create policy schema_migrations_admin_read on public.schema_migrations
    for select using (public.is_admin(auth.uid()));
exception
  when duplicate_object then null;
end $$;

insert into public.schema_migrations (version, note)
values ('0129_access_boundary', 'profiles/app_settings/api_keys locked; migration record created')
on conflict (version) do nothing;
