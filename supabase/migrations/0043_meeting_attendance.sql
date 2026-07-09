-- ============================================================
-- 0043_meeting_attendance.sql
-- Post-meeting follow-up: once a scheduled meeting (0042) has
-- ended, each attendee is prompted on next login — "did you
-- attend?" — and their answer is recorded per person here.
--
--   attendance   : NULL   -> not answered yet (still prompts)
--                  'attended' / 'missed' -> answered, stops prompting
--   responded_at : when they answered
--
-- Rescheduling a meeting (new start time) clears every attendee's
-- answer so they're asked again for the new slot (scheduled-actions.ts).
--
-- Idempotent: safe to re-run.
-- ============================================================

alter table public.meeting_attendees
  add column if not exists attendance   text
    check (attendance in ('attended', 'missed')),
  add column if not exists responded_at timestamptz;
