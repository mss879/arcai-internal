-- ============================================================
-- 0010_notifications.sql
-- In-app notifications (mentions, assignments, commissions).
-- ============================================================

create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  actor_id   uuid references public.profiles (id) on delete set null,
  type       text not null default 'system'
             check (type in ('mention', 'assignment', 'commission', 'system')),
  title      text not null,
  body       text,
  link       text,
  read       boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_idx on public.notifications (user_id, read);
create index if not exists notifications_created_idx on public.notifications (created_at desc);

alter table public.notifications enable row level security;

-- A user sees only their own notifications.
create policy "notifications: read own" on public.notifications
  for select to authenticated using (user_id = auth.uid());

-- Any member can create a notification for another member (e.g. @mention).
create policy "notifications: insert" on public.notifications
  for insert to authenticated with check (true);

-- A user can mark their own notifications read / delete them.
create policy "notifications: update own" on public.notifications
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "notifications: delete own" on public.notifications
  for delete to authenticated using (user_id = auth.uid());
