-- ============================================================
-- 0128_activity_heartbeat.sql
--
-- FIX THE MEMBER ACTIVITY MONITOR.
--
-- 0080 wrote one login_sessions row per *password sign-in* and bumped
-- last_active_at from the (app) layout. Both halves failed in practice:
--
--   * a member who stays signed in (an iPad that is only ever opened,
--     never logged into) produced no row at all — the monitor's last
--     entry was the last time they typed a password, weeks earlier;
--   * the heartbeat cookie died with the browser session, and the
--     layout it lived in is not re-rendered on client-side navigation,
--     so a live session got one bump if it got any.
--
-- The heartbeat now runs client-side against /api/activity/ping, which
-- can both bump a live row AND open a new one when there is no live
-- session — so "opened the app" is recorded whether or not a password
-- was involved. This migration adds the two things that needs.
--
--   1. `kind` — how the row started: 'login' (typed a password) or
--      'resume' (opened the app while already signed in). Purely
--      descriptive; the Activity modal labels resumed sessions so a
--      day of work is not misread as a day of repeated sign-ins.
--   2. An index for the "online now" lookup, which filters every
--      member's sessions by last_active_at and had no index for it.
-- ============================================================

alter table public.login_sessions
  add column if not exists kind text not null default 'login';

do $$
begin
  alter table public.login_sessions
    add constraint login_sessions_kind_check
    check (kind in ('login', 'resume'));
exception when duplicate_object then null;
end $$;

comment on column public.login_sessions.kind is
  'login = signed in with a password; resume = opened the app on an existing session.';

-- "Online now" (Team board dots, member page) reads every member whose
-- heartbeat landed inside the last few minutes.
create index if not exists login_sessions_active_idx
  on public.login_sessions (last_active_at desc);
