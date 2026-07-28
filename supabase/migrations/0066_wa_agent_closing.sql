-- ============================================================
-- 0066_wa_agent_closing.sql
-- Agent reliability, speed and close-rate work for warm
-- campaign leads (see 0065_wa_campaigns.sql for campaign mode).
--
-- Four columns on wa_contacts fix or measure real problems:
--
--   agent_answered_through  The watermark that replaces the old
--     "last_direction != 'in'" skip. That flag was flipped to
--     "out" by ANY outbound — including a showcase delivered
--     earlier in the same tick — which made the agent skip AND
--     permanently discard the customer's queued reply. A
--     timestamp of "the newest inbound we have actually
--     answered" can't be confused by showcases, promises,
--     follow-ups, cold outreach or failed sends.
--
--   agent_attempts  Backoff counter. A failed run now re-arms
--     instead of dropping the message; after 3 tries the chat is
--     flagged for a human.
--
--   first_reply_sent_at  CAS claim for the instant campaign
--     line. The contact upsert returns a row whether it inserted
--     or conflicted, so two concurrent webhook deliveries would
--     otherwise both greet the same person.
--
--   first_reply_seconds  How long the customer actually waited
--     for their first reply. Written once, so the Campaign tab
--     can aggregate it cheaply.
-- ============================================================

alter table public.wa_contacts
  add column if not exists agent_answered_through timestamptz;
alter table public.wa_contacts
  add column if not exists agent_attempts int not null default 0;
alter table public.wa_contacts
  add column if not exists first_reply_sent_at timestamptz;
alter table public.wa_contacts
  add column if not exists first_reply_seconds int;

-- Existing conversations: treat everything already received as
-- answered, so the watermark doesn't make the agent re-reply to
-- the whole inbox on deploy.
update public.wa_contacts
  set agent_answered_through = last_inbound_at
  where agent_answered_through is null
    and last_inbound_at is not null;

-- ---- The instant campaign line -------------------------------
-- Pre-written (AI-drafted from the campaign details, editable by
-- the team) so it can go out from the webhook in ~300ms, with no
-- model call. The considered agent reply follows behind it.
alter table public.wa_campaigns
  add column if not exists first_reply text;

-- ---- Wake up the weekly self-coaching loop -------------------
-- analyzeWaSalesWeek reads won/lost conversations and writes the
-- lessons straight into the agent's system prompt — but it was
-- only reachable from /api/intelligence/digest, which nothing
-- ever scheduled. Dead code, and wa_coaching sat empty. The tick
-- now runs it; this date is the once-a-day attempt gate, exactly
-- like cold_digest_sent_for, so a transient failure retries
-- tomorrow instead of every 60 seconds for a week.
alter table public.wa_agent_config
  add column if not exists coaching_ran_for date;

-- ---- Close the allowed_tools landmine ------------------------
-- 0048 shipped a 12-tool default; send_showcase (0049), send_quote
-- (0051), the promise pair (0054) and set_language (0055) were only
-- ever appended to EXISTING rows. getWaAgentConfig self-heals a
-- missing singleton with upsert({id: 1}), which would have used
-- that stale default — leaving an agent that can sell but cannot
-- close. Bring the default in line with the real catalog.
alter table public.wa_agent_config
  alter column allowed_tools set default array[
    'save_contact', 'get_context', 'research_contact', 'get_research',
    'audit_website', 'send_showcase', 'update_lead', 'create_task',
    'schedule_followup', 'schedule_promise', 'cancel_promise',
    'set_language', 'send_booking_link', 'create_proposal',
    'send_quote', 'notify_team', 'handoff_human'
  ]::text[];
