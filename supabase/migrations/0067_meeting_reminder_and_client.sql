-- ============================================================
-- 0067_meeting_reminder_and_client.sql
--
-- Two things the meeting form was missing:
--
--   reminder_hours  The reminder was hard-coded at 3 hours in
--     lib/meeting-reminders.ts, which is wrong in both directions
--     — an hour is plenty for a call you're already expecting,
--     and a site visit across Colombo needs the morning's notice.
--     Now set per meeting, 1 to 5 hours.
--
--   client_id  Meetings could only be assigned to teammates.
--     Most of them are WITH someone — and if that someone is new,
--     the client profile had to be created on a different page
--     first. Linking it here lets the form create the profile
--     inline and gives the team the "who is this with?" context
--     in the invite and the reminder.
-- ============================================================

alter table public.meetings
  add column if not exists reminder_hours int not null default 3;

-- Separate from the add so re-running against an existing column
-- still installs the bound.
do $$ begin
  alter table public.meetings
    add constraint meetings_reminder_hours_range
    check (reminder_hours between 1 and 5);
exception when duplicate_object then null; end $$;

alter table public.meetings
  add column if not exists client_id uuid
    references public.clients (id) on delete set null;

create index if not exists meetings_client_idx
  on public.meetings (client_id);
