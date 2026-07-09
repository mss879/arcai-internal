-- ============================================================
-- 0042_meetings_scheduled.sql
-- Scheduled team meetings created straight from the dashboard
-- calendar (the "+" now offers To-do OR Meeting).
--
-- These are DISTINCT from the public booking flow in 0008
-- (meeting_links / meeting_bookings, where a client picks a slot).
-- A meeting here is an internal event with:
--   * a title, details, start time + duration
--   * a type: 'online' (a join link is texted) or 'in_person'
--     (a venue/address is texted instead)
--   * assigned attendees (workspace members)
--
-- Alerts, mirroring the to-do model (0035/0036):
--   * on assignment  -> each newly-added attendee gets an instant
--     SMS + push + in-app notification (see meetings/scheduled-actions.ts)
--   * 3 hours before -> the automation tick texts every attendee a
--     reminder, WITH the join link for online meetings
--     (see lib/meeting-reminders.ts). meetings.reminder_sent_at makes
--     that fire exactly once; changing the start time re-arms it.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ---- Meetings -----------------------------------------------
create table if not exists public.meetings (
  id               uuid primary key default gen_random_uuid(),
  title            text not null,
  description      text,
  -- Start time, stored UTC (the client sends an ISO string).
  meeting_at       timestamptz not null,
  duration_minutes int  not null default 60
                   check (duration_minutes between 5 and 1440),
  -- 'online'    : meeting_url is the join link that gets texted
  -- 'in_person' : location is the venue/address that gets texted
  location_type    text not null default 'online'
                   check (location_type in ('online', 'in_person')),
  location         text,
  meeting_url      text,
  -- Set once the 3-hour reminder has gone out; cleared when the
  -- start time changes so the reminder re-arms (see scheduled-actions.ts).
  reminder_sent_at timestamptz,
  created_by       uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists meetings_meeting_at_idx
  on public.meetings (meeting_at);

-- Fast scan for "starting soon, not yet reminded" on every tick.
create index if not exists meetings_reminder_due_idx
  on public.meetings (meeting_at)
  where reminder_sent_at is null;

create or replace function public.set_meetings_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists meetings_set_updated_at on public.meetings;
create trigger meetings_set_updated_at
  before update on public.meetings
  for each row execute function public.set_meetings_updated_at();

-- ---- Attendees ----------------------------------------------
create table if not exists public.meeting_attendees (
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (meeting_id, user_id)
);

create index if not exists meeting_attendees_user_idx
  on public.meeting_attendees (user_id);

-- ---- RLS (single-workspace: any authenticated member) -------
alter table public.meetings          enable row level security;
alter table public.meeting_attendees enable row level security;

drop policy if exists "meetings: read all"   on public.meetings;
drop policy if exists "meetings: insert all" on public.meetings;
drop policy if exists "meetings: update all" on public.meetings;
drop policy if exists "meetings: delete all" on public.meetings;

create policy "meetings: read all"
  on public.meetings for select to authenticated using (true);
create policy "meetings: insert all"
  on public.meetings for insert to authenticated with check (true);
create policy "meetings: update all"
  on public.meetings for update to authenticated using (true) with check (true);
create policy "meetings: delete all"
  on public.meetings for delete to authenticated using (true);

drop policy if exists "meeting_attendees: read all"   on public.meeting_attendees;
drop policy if exists "meeting_attendees: insert all" on public.meeting_attendees;
drop policy if exists "meeting_attendees: update all" on public.meeting_attendees;
drop policy if exists "meeting_attendees: delete all" on public.meeting_attendees;

create policy "meeting_attendees: read all"
  on public.meeting_attendees for select to authenticated using (true);
create policy "meeting_attendees: insert all"
  on public.meeting_attendees for insert to authenticated with check (true);
create policy "meeting_attendees: update all"
  on public.meeting_attendees for update to authenticated using (true) with check (true);
create policy "meeting_attendees: delete all"
  on public.meeting_attendees for delete to authenticated using (true);

-- ---- Log meeting reminders in the SMS history ---------------
alter table public.sms_messages
  drop constraint if exists sms_messages_kind_check;

alter table public.sms_messages
  add constraint sms_messages_kind_check
  check (kind in (
    'custom', 'payment_reminder', 'automation', 'promotion',
    'todo_reminder', 'meeting_reminder'
  ));

-- ---- Live updates (optional; ignored if FOR ALL TABLES) -----
do $$
begin
  alter publication supabase_realtime add table public.meetings;
exception when others then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.meeting_attendees;
exception when others then null;
end $$;
