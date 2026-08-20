-- ============================================================
-- 0079_trusted_devices.sql
-- Strict device lock for members: each member registers up to
-- 2 trusted devices (identified by a long-lived httpOnly cookie
-- token, never by IP/network). Once device #1 is trusted, only
-- trusted devices can sign in; device #2 joins via an SMS PIN.
-- Members get a 48h window (from first seeing the in-app alert)
-- to register their first device. Members cannot remove devices
-- — only admins can reset them. Admins are exempt from the lock.
-- ============================================================

create table if not exists public.trusted_devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  -- sha256 of the device cookie token; the raw token only lives in the
  -- member's browser cookie and is never stored server-side.
  token_hash   text not null unique,
  label        text not null default 'Unknown device',
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists trusted_devices_user_idx
  on public.trusted_devices (user_id);

-- Per-member device-registration state: the 48h first-device window (row is
-- created the first time the member loads the app after this ships) and the
-- pending SMS PIN used to register the second device from the login screen.
create table if not exists public.device_grace (
  user_id              uuid primary key references public.profiles (id) on delete cascade,
  started_at           timestamptz not null default now(),
  pair_code_hash       text,
  pair_code_expires_at timestamptz,
  pair_code_attempts   int not null default 0,
  pair_code_sent_at    timestamptz
);

alter table public.trusted_devices enable row level security;
alter table public.device_grace    enable row level security;

-- Read: own rows, or any row for admins (Team page shows every member's devices).
create policy "trusted_devices: select own or admin" on public.trusted_devices
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin(auth.uid()));
create policy "device_grace: select own or admin" on public.device_grace
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin(auth.uid()));

-- Deliberately NO insert/update/delete policies on either table: every write
-- goes through the service role in server code, so the 2-device cap, the 48h
-- clock, and "members cannot remove devices" can't be bypassed by calling
-- PostgREST directly with a member JWT.

-- ---- Live updates (optional; ignored if FOR ALL TABLES) -----
do $$
begin
  alter publication supabase_realtime add table public.trusted_devices;
exception when others then null;
end $$;
