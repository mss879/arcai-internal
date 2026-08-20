-- ============================================================
-- 0080_login_sessions.sql
-- Member login monitoring for admins: one row per member sign-in
-- with the time, device, IP and location (from Netlify's geo
-- header). `last_active_at` is bumped (throttled) on every page
-- navigation, so "how long they stayed active" is the gap between
-- logged_in_at and last_active_at. Admins read this from the
-- Team page ⋮ → Activity. Members are logged; admins are not.
-- ============================================================

create table if not exists public.login_sessions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  -- Which trusted device signed in, when known. Label is denormalized so
  -- history stays readable after an admin resets the member's devices.
  device_id      uuid references public.trusted_devices (id) on delete set null,
  device_label   text,
  ip             text,
  city           text,
  region         text,
  country        text,
  user_agent     text,
  logged_in_at   timestamptz not null default now(),
  last_active_at timestamptz not null default now()
);

create index if not exists login_sessions_user_time_idx
  on public.login_sessions (user_id, logged_in_at desc);

alter table public.login_sessions enable row level security;

-- Read: your own history, or everyone's for admins (Activity modal).
create policy "login_sessions: select own or admin" on public.login_sessions
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin(auth.uid()));

-- No insert/update/delete policies: rows are written by the service role
-- during login and the activity heartbeat, so members can't forge or
-- scrub their own history via PostgREST.
