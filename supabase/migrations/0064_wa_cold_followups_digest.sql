-- ============================================================
-- 0064_wa_cold_followups_digest.sql
-- Cold outreach round 2:
--
--   Follow-up nudge — a cold message that was DELIVERED but got no
--   reply for N days earns ONE follow-up template, then the lead is
--   left alone forever. Nudges consume the same daily cap as first
--   touches, so total business-initiated sends per day never grow.
--
--   replied_at — exact timestamp of the reply flip, so the daily
--   digest can honestly report "replies yesterday".
--
--   cold_digest_sent_for — once-a-day dedupe marker for the morning
--   outreach digest notification.
-- ============================================================

-- ---- Nudge + reply tracking on the outreach rows --------------
alter table public.wa_cold_outreach
  add column if not exists followup_sent_at timestamptz;   -- nudge ATTEMPT time (set even when the send fails)
alter table public.wa_cold_outreach
  add column if not exists followup_wa_message_id text;    -- wamid of the nudge (delivery-status join key)
alter table public.wa_cold_outreach
  add column if not exists replied_at timestamptz;         -- when the reply was detected

-- ---- Agent config: nudge template + digest marker -------------
alter table public.wa_agent_config
  add column if not exists cold_followup_template_name text;
alter table public.wa_agent_config
  add column if not exists cold_followup_template_lang text not null default 'en';
alter table public.wa_agent_config
  add column if not exists cold_followup_template_params text[] not null default '{}';
alter table public.wa_agent_config
  add column if not exists cold_followup_days int not null default 3
    check (cold_followup_days between 1 and 14);
-- Colombo-local date the morning digest last went out (claim-first dedupe).
alter table public.wa_agent_config
  add column if not exists cold_digest_sent_for date;
