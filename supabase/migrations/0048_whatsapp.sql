-- ============================================================
-- 0048_whatsapp.sql
-- WhatsApp Business system — inbox, AI sales agent, keyword
-- automations, deep CRM integration:
--
--   wa_contacts       : one row per WhatsApp number that ever messaged
--                       us (or that we messaged). Links to the CRM lead
--                       + client the agent auto-creates.
--   wa_messages       : the full chat history, both directions, with
--                       Meta delivery statuses (sent/delivered/read).
--   wa_agent_config   : singleton — the AI agent's persona, knowledge
--                       base, greeting, lead-creation defaults and the
--                       EXACT set of CRM tools it is allowed to use.
--   wa_keyword_rules  : instant keyword automations (auto-reply, tag,
--                       notify, human handoff, enroll an automation).
--   wa_agent_logs     : audit trail of every tool the agent invoked.
--
-- Also extends the automation engine:
--   * new trigger  `wa_message_received` (optional keyword filter in
--     trigger_config) — fired for every inbound WhatsApp message
--   * new step     `send_whatsapp` — free-form text inside the 24h
--     customer-service window, or a pre-approved template outside it
-- ============================================================

-- ---- Contacts ------------------------------------------------
create table if not exists public.wa_contacts (
  id                   uuid primary key default gen_random_uuid(),
  -- Digits-only international number (Meta's wa_id), e.g. 94771234567.
  wa_id                text not null unique,
  -- The WhatsApp push-name from their profile (untrusted, display only).
  profile_name         text,
  -- The name the agent/team captured ("what's your name?" flow).
  display_name         text,
  lead_id              uuid references public.leads (id) on delete set null,
  client_id            uuid references public.clients (id) on delete set null,
  -- Per-conversation kill switch for the AI agent.
  agent_enabled        boolean not null default true,
  -- Set by the handoff tool / keyword rules — "a human should look".
  needs_attention      boolean not null default false,
  unread               integer not null default 0,
  last_message_at      timestamptz,
  last_message_preview text,
  last_direction       text check (last_direction in ('in', 'out')),
  -- Last INBOUND message — the 24h free-form messaging window anchor.
  last_inbound_at      timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists wa_contacts_recent_idx
  on public.wa_contacts (last_message_at desc nulls last);

drop trigger if exists wa_contacts_set_updated_at on public.wa_contacts;
create trigger wa_contacts_set_updated_at
  before update on public.wa_contacts
  for each row execute function public.set_updated_at();

-- ---- Messages ------------------------------------------------
create table if not exists public.wa_messages (
  id            uuid primary key default gen_random_uuid(),
  contact_id    uuid not null references public.wa_contacts (id) on delete cascade,
  -- Meta's message id (wamid.…). Unique = inbound webhook retries dedupe.
  wa_message_id text unique,
  direction     text not null check (direction in ('in', 'out')),
  message_type  text not null default 'text',
  body          text not null default '',
  status        text not null default 'received'
                check (status in ('received', 'sent', 'delivered', 'read', 'failed')),
  error         text,
  -- Who authored an outbound message.
  sent_by       text check (sent_by in ('agent', 'team', 'automation', 'keyword')),
  author_id     uuid references public.profiles (id) on delete set null,
  meta          jsonb not null default '{}',
  created_at    timestamptz not null default now()
);

create index if not exists wa_messages_thread_idx
  on public.wa_messages (contact_id, created_at);

-- ---- Agent config (singleton) --------------------------------
create table if not exists public.wa_agent_config (
  id               integer primary key default 1 check (id = 1),
  enabled          boolean not null default true,
  agent_name       text not null default 'Arc',
  greeting         text not null default
    'Hi! 👋 Thanks for messaging ARC AI — we build business websites, e-commerce stores and AI automations. May I have your name so I can help you better?',
  -- Extra persona/system instructions layered onto the built-in prompt.
  persona          text not null default '',
  -- The knowledge base: services, pricing, FAQs — pasted by the team.
  knowledge        text not null default '',
  ask_name         boolean not null default true,
  auto_create_lead boolean not null default true,
  -- Where agent-created leads land; null = first pipeline / first stage.
  pipeline_id      uuid references public.pipelines (id) on delete set null,
  stage_id         uuid references public.pipeline_stages (id) on delete set null,
  lead_source      text not null default 'whatsapp',
  -- Exact tool keys the agent may call (see src/lib/wa-tools-catalog.ts).
  allowed_tools    text[] not null default array[
    'save_contact', 'get_context', 'research_contact', 'get_research',
    'update_lead', 'create_task', 'schedule_followup', 'send_booking_link',
    'create_proposal', 'notify_team', 'handoff_human'
  ],
  updated_at       timestamptz not null default now()
);

drop trigger if exists wa_agent_config_set_updated_at on public.wa_agent_config;
create trigger wa_agent_config_set_updated_at
  before update on public.wa_agent_config
  for each row execute function public.set_updated_at();

insert into public.wa_agent_config (id) values (1)
on conflict (id) do nothing;

-- ---- Keyword rules -------------------------------------------
create table if not exists public.wa_keyword_rules (
  id            uuid primary key default gen_random_uuid(),
  keyword       text not null,
  match_type    text not null default 'contains'
                check (match_type in ('exact', 'contains', 'starts_with')),
  -- What the rule does (any combination):
  reply         text,                                   -- instant auto-reply
  add_tag       text,                                   -- tag the linked lead
  notify_team   boolean not null default false,         -- ping everyone
  handoff       boolean not null default false,         -- pause AI + flag human
  automation_id uuid references public.automations (id) on delete set null,
  is_active     boolean not null default true,
  hits          integer not null default 0,
  position      integer not null default 0,
  created_at    timestamptz not null default now()
);

create index if not exists wa_keyword_rules_active_idx
  on public.wa_keyword_rules (position) where is_active;

-- ---- Agent action audit log ----------------------------------
create table if not exists public.wa_agent_logs (
  id         uuid primary key default gen_random_uuid(),
  contact_id uuid references public.wa_contacts (id) on delete cascade,
  tool       text not null,
  args       jsonb not null default '{}',
  ok         boolean not null default true,
  result     text,
  created_at timestamptz not null default now()
);

create index if not exists wa_agent_logs_recent_idx
  on public.wa_agent_logs (created_at desc);

-- ---- Automation engine: new trigger + step -------------------
alter table public.automations
  drop constraint if exists automations_trigger_check;
alter table public.automations
  add constraint automations_trigger_check check (trigger in (
    'lead_created', 'form_submitted', 'stage_changed', 'tag_added',
    'lead_inactive', 'date_reached', 'invoice_unpaid', 'installment_due',
    'cheque_due', 'quote_accepted', 'client_created', 'webhook',
    'wa_message_received'   -- inbound WhatsApp (trigger_config.keyword filters)
  ));

alter table public.automation_steps
  drop constraint if exists automation_steps_kind_check;
alter table public.automation_steps
  add constraint automation_steps_kind_check check (kind in (
    'send_sms', 'send_email', 'create_task', 'add_tag', 'remove_tag',
    'assign_user', 'move_stage', 'update_field', 'update_score', 'notify',
    'webhook', 'ai_agent', 'enroll_sms_workflow', 'wait',
    'send_whatsapp'         -- config: { message, template_name?, template_lang? }
  ));

-- ---- RLS + realtime (single-workspace: any authenticated) ----
do $$
declare t text;
begin
  foreach t in array array[
    'wa_contacts', 'wa_messages', 'wa_agent_config',
    'wa_keyword_rules', 'wa_agent_logs'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    begin
      execute format('create policy "%s: read all" on public.%I for select to authenticated using (true)', t, t);
    exception when duplicate_object then null; end;
    begin
      execute format('create policy "%s: insert all" on public.%I for insert to authenticated with check (true)', t, t);
    exception when duplicate_object then null; end;
    begin
      execute format('create policy "%s: update all" on public.%I for update to authenticated using (true) with check (true)', t, t);
    exception when duplicate_object then null; end;
    begin
      execute format('create policy "%s: delete all" on public.%I for delete to authenticated using (true)', t, t);
    exception when duplicate_object then null; end;
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when others then null; end;
  end loop;
end $$;
