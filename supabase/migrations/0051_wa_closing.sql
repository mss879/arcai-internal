-- ============================================================
-- 0051_wa_closing.sql
-- WhatsApp sales machine — the Closing Room + the Follow-up Brain:
--
--   Closing Room  : the agent sends a real e-sign quote in chat
--                   (new `send_quote` tool). Signing fires the
--                   existing quote_accepted trigger; a new step
--                   converts it to an invoice + payment plan and
--                   WhatsApps the payment details.
--   Follow-up Brain: the agent chases its own quiet deals — a
--                   3-touch cadence anchored to its last outbound
--                   message, cleared instantly by any reply.
--
--   wa_contacts       : + followup_stage / next_followup_at (cadence)
--                       + do_not_contact (opt-out hardening)
--   wa_agent_config   : + followups_enabled, followup_template_name/
--                       lang (outside the 24h window), and
--                       max_autonomous_discount_pct (discount authority)
--
-- Also extends the automation engine:
--   * new triggers `quote_viewed`   — client opened the /q share link
--                  `payment_received` — an installment marked paid
--   * new steps    `convert_quote_to_invoice` — accepted quote →
--                  invoice + payment plan (deposit + balance)
--                  `create_project` — spin up a project from the run
-- ============================================================

-- ---- Contacts: follow-up cadence + opt-out -------------------
alter table public.wa_contacts
  add column if not exists followup_stage integer not null default 0;
alter table public.wa_contacts
  add column if not exists next_followup_at timestamptz;
alter table public.wa_contacts
  add column if not exists do_not_contact boolean not null default false;

create index if not exists wa_contacts_followup_due_idx
  on public.wa_contacts (next_followup_at)
  where next_followup_at is not null;

-- ---- Agent config: follow-ups + discount authority -----------
alter table public.wa_agent_config
  add column if not exists followups_enabled boolean not null default true;
alter table public.wa_agent_config
  add column if not exists followup_template_name text;
alter table public.wa_agent_config
  add column if not exists followup_template_lang text not null default 'en';
-- 0 = the agent may never discount on its own.
alter table public.wa_agent_config
  add column if not exists max_autonomous_discount_pct integer not null default 0;

-- ---- Ensure the new agent tool is allowed on existing installs
update public.wa_agent_config
  set allowed_tools = allowed_tools || '{send_quote}'
  where not ('send_quote' = any(allowed_tools));

-- ---- Automation engine: new triggers + steps -----------------
alter table public.automations
  drop constraint if exists automations_trigger_check;
alter table public.automations
  add constraint automations_trigger_check check (trigger in (
    'lead_created', 'form_submitted', 'stage_changed', 'tag_added',
    'lead_inactive', 'date_reached', 'invoice_unpaid', 'installment_due',
    'cheque_due', 'quote_accepted', 'client_created', 'webhook',
    'wa_message_received',
    'quote_viewed',      -- client opened the /q/<token> share link
    'payment_received'   -- a payment-plan installment was marked paid
  ));

alter table public.automation_steps
  drop constraint if exists automation_steps_kind_check;
alter table public.automation_steps
  add constraint automation_steps_kind_check check (kind in (
    'send_sms', 'send_email', 'create_task', 'add_tag', 'remove_tag',
    'assign_user', 'move_stage', 'update_field', 'update_score', 'notify',
    'webhook', 'ai_agent', 'enroll_sms_workflow', 'wait',
    'send_whatsapp',
    'convert_quote_to_invoice', -- accepted quote → invoice + payment plan
    'create_project'            -- create a project from the run's context
  ));
