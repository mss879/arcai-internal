-- ============================================================
-- 0102_assistant_proactive.sql
--
-- ARCUS SPEAKS FIRST — the events feed behind the morning
-- briefing and the bubble's nudges.
--
-- Until now the assistant only ever answered. Everything it
-- knows, it knew because someone asked. Meanwhile the app is
-- already full of things worth saying: an invoice went overdue,
-- a project's margin turned negative, a job has been blocked
-- for a week, a payment landed.
--
-- Those alerts already exist and already notify — finance
-- reminders, stalled-project alerts, the risk radar, the
-- anomaly guards. This migration does NOT add another shouter.
-- It adds a place for the assistant to COLLECT what those
-- subsystems already worked out, so that:
--
--   • one curated briefing can replace a scatter of pings, and
--   • the two or three genuinely urgent items can interrupt,
--     bounded by the member's own quiet hours and daily budget.
--
--   • ASSISTANT_EVENTS — one row per noticed thing.
--     `dedupe_key` is the whole trick: "invoice-overdue:<id>:
--     <isoWeek>" upserts, so a condition that stays true for a
--     week is one event, not one per tick. `importance` decides
--     interrupt (3-4) versus wait-for-the-briefing (1-2), and
--     `surfaced_via` records where it ended up so the briefing
--     never repeats what already buzzed a phone.
--     user_id NULL = the whole team's business, not one
--     person's.
--
--   • notifications.type gains 'assistant', because a briefing
--     is not a mention, an assignment or a commission, and the
--     bell's icon map should be able to tell.
-- ============================================================

-- 1. The bell learns a new kind ------------------------------
-- Old clients degrade safely: notifications-bell.tsx falls back
-- to a generic icon for a type it does not recognise.
alter table public.notifications
  drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in ('mention', 'assignment', 'commission', 'system', 'assistant'));

-- 2. The events feed -----------------------------------------
create table if not exists public.assistant_events (
  id         uuid primary key default gen_random_uuid(),
  -- NULL means "the workspace", which is most of them: an overdue invoice is
  -- not one person's business in a single-workspace agency.
  user_id    uuid references public.profiles (id) on delete cascade,
  -- Which watcher raised it: finance | projects | anomaly | risk | delivery |
  -- memory | mission | watcher. Text, not an enum, so a new watcher does not
  -- need a migration to be heard.
  source     text not null,
  kind       text not null default 'info'
             check (kind in ('info', 'warning', 'win', 'action')),
  title      text not null,
  body       text,
  href       text,
  -- 1 trivia · 2 worth a mention in the briefing · 3 should interrupt today ·
  -- 4 interrupt now. The nudge budget only ever spends itself on 3 and 4.
  importance int not null default 2 check (importance between 1 and 4),
  -- The same condition seen twice must be one row. Unique WHERE NOT NULL so a
  -- one-off event can still be written without inventing a key.
  dedupe_key text,
  payload    jsonb not null default '{}'::jsonb,
  status     text not null default 'new'
             check (status in ('new', 'surfaced', 'dismissed', 'done')),
  -- Where it has already been shown: {'nudge'}, {'briefing'}, or both.
  surfaced_via text[] not null default '{}',
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create unique index if not exists assistant_events_dedupe_idx
  on public.assistant_events (dedupe_key)
  where dedupe_key is not null;

create index if not exists assistant_events_open_idx
  on public.assistant_events (status, importance desc, created_at desc);

-- 3. RLS ------------------------------------------------------
-- Readable by the person it is for, or by everyone when it belongs to the
-- workspace. Writes come from the tick's service-role client.
alter table public.assistant_events enable row level security;

drop policy if exists "assistant_events_read" on public.assistant_events;
create policy "assistant_events_read" on public.assistant_events
  for select using (user_id is null or user_id = auth.uid());

-- Dismissing is the one thing a person does to an event by hand.
drop policy if exists "assistant_events_update" on public.assistant_events;
create policy "assistant_events_update" on public.assistant_events
  for update using (user_id is null or user_id = auth.uid())
  with check (user_id is null or user_id = auth.uid());

-- 4. Realtime (0021 guard pattern) ----------------------------
-- The bubble's nudge chip appears without a reload.
do $$
declare
  t text;
begin
  foreach t in array array['assistant_events'] loop
    begin
      execute format(
        'alter publication supabase_realtime add table public.%I', t
      );
    exception
      when duplicate_object then null; -- already published
      when others then null;           -- e.g. publication is FOR ALL TABLES
    end;
  end loop;
end $$;
