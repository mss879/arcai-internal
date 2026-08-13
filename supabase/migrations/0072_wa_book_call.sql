-- ============================================================
-- 0072_wa_book_call.sql
-- The agent books a CALL TIME, not a video meeting.
--
-- Sri Lankan buyers don't respond to "here's my booking link,
-- pick a slot" — a link plus a video call is friction, and the
-- lead goes cold on the page. What works is the human question:
-- "what time suits you for a call?" So send_booking_link is
-- retired and replaced by book_call:
--
--   1. The agent agrees a real day + time in the chat.
--   2. book_call writes a To-Do on the board, due exactly at that
--      moment, titled with who to ring and carrying everything
--      they're interested in as the notes.
--   3. The existing todo reminder (lib/todo-reminders.ts) then
--      texts + pushes the assignee 5 hours before the call, for
--      free — no new reminder machinery.
--
-- Three things have to happen in the database:
--
--   * wa_contacts.call_booked_at / call_todo_id — so the agent
--     knows a call is already arranged (it must not re-ask), and
--     so a RESCHEDULE updates the same To-Do instead of leaving a
--     stale one on the board.
--
--   * allowed_tools — the agent can only call tools listed in
--     wa_agent_config.allowed_tools. That array is a stored row,
--     so shipping the code alone would leave book_call invisible
--     and send_booking_link still offered. Swapped here, and the
--     column default is brought in line for a fresh install.
--
--   * Nothing is dropped: the Meetings/booking-page feature stays
--     exactly as it is for manual use. Only the AGENT stops
--     handing out links.
-- ============================================================

alter table public.wa_contacts
  add column if not exists call_booked_at timestamptz;
alter table public.wa_contacts
  add column if not exists call_todo_id uuid
    references public.todos (id) on delete set null;

-- ---- Swap the tool on the live config -------------------------
-- Idempotent: re-running never duplicates book_call.
-- array_append (not ||) because Postgres reads a bare 'book_call'
-- on the right of || as an array literal and rejects it.
update public.wa_agent_config
  set allowed_tools =
    case
      when 'book_call' = any(allowed_tools)
        then array_remove(allowed_tools, 'send_booking_link')
      else array_append(
             array_remove(allowed_tools, 'send_booking_link'),
             'book_call'::text
           )
    end
  where id = 1;

-- ---- ...and for any future singleton self-heal ----------------
alter table public.wa_agent_config
  alter column allowed_tools set default array[
    'save_contact', 'get_context', 'research_contact', 'get_research',
    'audit_website', 'send_showcase', 'update_lead', 'create_task',
    'schedule_followup', 'schedule_promise', 'cancel_promise',
    'set_language', 'book_call', 'create_proposal',
    'send_quote', 'notify_team', 'handoff_human'
  ]::text[];
