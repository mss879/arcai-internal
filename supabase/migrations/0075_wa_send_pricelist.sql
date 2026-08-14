-- ============================================================
-- 0075_wa_send_pricelist.sql
-- New agent tool: send_pricelist.
--
--   When a customer explicitly asks for the full price list —
--   or needs something to show a partner/boss — the agent
--   delivers the branded pricing PDF (the same one the /pricing
--   page exports, with the team's live price overrides) straight
--   into the chat as a WhatsApp document.
--
--   Prompt rules keep it an ON-REQUEST move only: the PRICE CARD
--   in chat stays the default way prices are presented.
--
--   allowed_tools is a stored row, so shipping code alone would
--   leave the tool invisible — append it here and refresh the
--   column default for fresh installs.
-- ============================================================

-- Idempotent: re-running never duplicates send_pricelist.
update public.wa_agent_config
  set allowed_tools = array_append(allowed_tools, 'send_pricelist'::text)
  where id = 1
    and not ('send_pricelist' = any(allowed_tools));

alter table public.wa_agent_config
  alter column allowed_tools set default array[
    'save_contact', 'get_context', 'research_contact', 'get_research',
    'audit_website', 'send_showcase', 'update_lead', 'create_task',
    'schedule_followup', 'schedule_promise', 'cancel_promise',
    'set_language', 'book_call', 'create_proposal',
    'send_quote', 'send_pricelist', 'notify_team', 'handoff_human'
  ]::text[];
