-- ============================================================
-- 0052_wa_inbound.sql
-- WhatsApp sales machine — inbound hardening:
--
--   Agent-run queue : inbound messages no longer run the AI inside
--                     the webhook. Each message arms wa_contacts.
--                     agent_due_at (now + debounce); the automation
--                     tick drains due runs. Bursts of messages
--                     collapse into ONE reply, and long runs (site
--                     audit + tools) can't be killed by the
--                     webhook's serverless budget.
--   Quiet hours     : agent-initiated nudges (follow-up touches,
--                     cold outreach) due during the configured
--                     night window are delivered next morning
--                     instead. Replies to customers are NEVER
--                     delayed — the agent answers 24/7.
--
-- Vision (payment slips, photos) needs no schema: image analysis
-- lives in wa_messages.body + meta (jsonb), like voice notes.
-- ============================================================

-- ---- Contacts: the agent-run queue (debounce + lease) --------
alter table public.wa_contacts
  add column if not exists agent_due_at timestamptz;

create index if not exists wa_contacts_agent_due_idx
  on public.wa_contacts (agent_due_at)
  where agent_due_at is not null;

-- ---- Agent config: quiet hours for self-initiated nudges -----
alter table public.wa_agent_config
  add column if not exists quiet_hours_enabled boolean not null default true;
alter table public.wa_agent_config
  add column if not exists quiet_hours_start smallint not null default 21; -- 21:00 local
alter table public.wa_agent_config
  add column if not exists quiet_hours_end smallint not null default 9;    -- 09:00 local
alter table public.wa_agent_config
  add column if not exists timezone text not null default 'Asia/Colombo';
