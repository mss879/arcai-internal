-- ============================================================
-- 0036_todo_reminders.sql
-- Deadline reminders for to-dos: 5 hours before a task's
-- due_date the automation tick sends an SMS (ARC AI mask),
-- a push and an in-app notification to the assignee + creator.
--
--   * todos.reminder_sent_at marks the reminder as dispatched
--     so it fires exactly once; saving a task with a new due
--     date clears it, re-arming the reminder.
--   * sms_messages.kind gains 'todo_reminder' so these texts
--     show up in the SMS history log.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- --- Bookkeeping flag on tasks -------------------------------
alter table public.todos
  add column if not exists reminder_sent_at timestamptz;

-- Fast scan for "due soon, not yet reminded" on every tick.
create index if not exists todos_reminder_due_idx
  on public.todos (due_date)
  where reminder_sent_at is null and due_date is not null and status <> 'done';

-- --- Log todo reminders in the SMS history -------------------
alter table public.sms_messages
  drop constraint if exists sms_messages_kind_check;

alter table public.sms_messages
  add constraint sms_messages_kind_check
  check (kind in ('custom', 'payment_reminder', 'automation', 'promotion', 'todo_reminder'));
