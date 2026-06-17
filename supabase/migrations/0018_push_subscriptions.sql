-- ============================================================
-- 0018_push_subscriptions.sql
-- Web Push (browser/device) subscriptions for background
-- notifications — assignments, @mentions, meeting bookings.
-- One row per device/browser a user enables notifications on.
-- ============================================================

create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

-- A user manages only their own device subscriptions. Sending pushes
-- happens server-side with the service-role key, which bypasses RLS.
create policy "push_subs: select own" on public.push_subscriptions
  for select to authenticated using (user_id = auth.uid());
create policy "push_subs: insert own" on public.push_subscriptions
  for insert to authenticated with check (user_id = auth.uid());
create policy "push_subs: delete own" on public.push_subscriptions
  for delete to authenticated using (user_id = auth.uid());
