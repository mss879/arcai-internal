-- ============================================================
-- 0078_wa_agent_round3.sql
-- Round 3 — opt-out intelligence + the morning agent digest.
--
--   opt_out tool: the keyword detector catches hard phrases
--   ("stop", "unsubscribe", …) instantly, but nuanced or
--   other-language requests ("please don't send me these
--   anymore", Tamil phrasing) sailed past it. The MODEL can now
--   honor those itself. In the same change, "not interested"
--   stops being an auto-opt-out — it's a sales objection the
--   playbook is built to answer, and the keyword path was
--   killing those leads before the agent ever saw them.
--
--   agent_digest_sent_for: once-a-day claim stamp for the
--   morning agent digest (mirrors cold_digest_sent_for, 0064).
-- ============================================================

-- Idempotent: re-running never duplicates opt_out.
update public.wa_agent_config
  set allowed_tools = array_append(allowed_tools, 'opt_out'::text)
  where id = 1
    and not ('opt_out' = any(allowed_tools));

alter table public.wa_agent_config
  alter column allowed_tools set default array[
    'save_contact', 'get_context', 'research_contact', 'get_research',
    'audit_website', 'send_showcase', 'update_lead', 'create_task',
    'schedule_followup', 'schedule_promise', 'cancel_promise',
    'set_language', 'book_call', 'create_proposal',
    'send_quote', 'send_pricelist', 'notify_team', 'handoff_human',
    'opt_out'
  ]::text[];

alter table public.wa_agent_config
  add column if not exists agent_digest_sent_for date;
