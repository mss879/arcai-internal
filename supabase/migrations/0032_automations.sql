-- ============================================================
-- 0032_automations.sql
-- Automation engine — trigger → condition → actions:
--
--   automations          : a workflow (trigger + conditions + active flag)
--   automation_steps     : ordered actions (send SMS/email, task, tag,
--                          assign, move stage, update field, webhook,
--                          AI agent, notify, wait)
--   automation_runs      : one enrollment of a subject (lead/client)
--                          into an automation; next_run_at drives timers
--   webhook_endpoints    : inbound webhooks (/api/public/hooks/<token>)
--                          that create leads / fire automations
--   api_keys             : open API keys for /api/public/v1/*
--   app_settings         : workspace key→value settings (business
--                          profile, tax rate, tracking site, …)
--
-- Time-based triggers (inactivity, due dates, unpaid invoices) are
-- evaluated by /api/automation/tick; event triggers (lead created,
-- stage changed, tag added, form submitted, quote accepted) are fired
-- in-process by the app's write paths.
-- ============================================================

-- ---- Automations --------------------------------------------
create table if not exists public.automations (
  id             uuid primary key default gen_random_uuid(),
  name           text not null default 'Untitled automation',
  description    text,
  is_active      boolean not null default true,
  -- Trigger library.
  trigger        text not null default 'lead_created'
                 check (trigger in (
                   'lead_created',       -- new lead in the CRM (any source)
                   'form_submitted',     -- public inquiry form / webhook lead
                   'stage_changed',      -- lead moved to a stage
                   'tag_added',          -- tag applied to a lead
                   'lead_inactive',      -- no activity for X days
                   'date_reached',       -- expected close date approaching
                   'invoice_unpaid',     -- invoice sent, no paid stamp after X days
                   'installment_due',    -- payment plan installment due in X days
                   'cheque_due',         -- post-dated cheque due in X days
                   'quote_accepted',     -- quote e-signed by the client
                   'client_created',     -- new client added
                   'webhook'             -- inbound webhook endpoint fired
                 )),
  -- Trigger tuning, e.g. { pipeline_id, stage_id, tag, days, offset_days }.
  trigger_config jsonb not null default '{}',
  -- Conditions, all must pass: [{ field, op, value }]
  -- field: source|tags|score|status|value|stage_id|assigned_to|pipeline_id
  -- op: eq|neq|contains|not_contains|gt|lt|is_set|not_set
  conditions     jsonb not null default '[]',
  -- Stats shown in the UI.
  runs_started   integer not null default 0,
  last_run_at    timestamptz,
  created_by     uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists automations_trigger_idx on public.automations (trigger) where is_active;

drop trigger if exists automations_set_updated_at on public.automations;
create trigger automations_set_updated_at
  before update on public.automations
  for each row execute function public.set_updated_at();

-- ---- Steps (actions) ----------------------------------------
create table if not exists public.automation_steps (
  id            uuid primary key default gen_random_uuid(),
  automation_id uuid not null references public.automations (id) on delete cascade,
  position      integer not null default 0,
  kind          text not null default 'send_sms'
                check (kind in (
                  'send_sms',            -- config: { message }  ({{name}} tokens)
                  'send_email',          -- config: { subject, body }
                  'create_task',         -- config: { title, notes, due_in_days, assigned_to }
                  'add_tag',             -- config: { tag }
                  'remove_tag',          -- config: { tag }
                  'assign_user',         -- config: { user_id }
                  'move_stage',          -- config: { stage_id }
                  'update_field',        -- config: { field, value } (lead column or custom.KEY)
                  'update_score',        -- config: { score: hot|warm|cold }
                  'notify',              -- config: { user_id|all, title, body } in-app + push
                  'webhook',             -- config: { url, payload? } POST JSON
                  'ai_agent',            -- config: { instruction, save_to: ai_summary|ai_next_action|note }
                  'enroll_sms_workflow', -- config: { workflow_id } (SMS drip from the SMS page)
                  'wait'                 -- config: { minutes }
                )),
  config        jsonb not null default '{}',
  created_at    timestamptz not null default now()
);

create index if not exists automation_steps_automation_idx
  on public.automation_steps (automation_id, position);

-- ---- Runs (enrollments) -------------------------------------
create table if not exists public.automation_runs (
  id            uuid primary key default gen_random_uuid(),
  automation_id uuid not null references public.automations (id) on delete cascade,
  lead_id       uuid references public.leads (id) on delete set null,
  client_id     uuid references public.clients (id) on delete set null,
  -- Snapshot of who this run is about (kept if the record is deleted).
  subject_name  text not null default '',
  subject_phone text,
  subject_email text,
  -- Extra trigger payload usable in tokens, e.g. { invoice_number, amount }.
  context       jsonb not null default '{}',
  -- De-dup key so time-based triggers don't re-enroll the same subject
  -- for the same occurrence (e.g. "lead-x:inactive:2026-07-04").
  trigger_key   text,
  step_index    integer not null default 0,
  status        text not null default 'running'
                check (status in ('running', 'completed', 'cancelled', 'failed')),
  next_run_at   timestamptz not null default now(),
  -- Append-only log of what each executed step did.
  log           jsonb not null default '[]',
  error         text,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);

create unique index if not exists automation_runs_dedupe_idx
  on public.automation_runs (automation_id, trigger_key)
  where trigger_key is not null;
create index if not exists automation_runs_due_idx
  on public.automation_runs (status, next_run_at);
create index if not exists automation_runs_automation_idx
  on public.automation_runs (automation_id, created_at desc);

-- ---- Inbound webhooks ---------------------------------------
create table if not exists public.webhook_endpoints (
  id           uuid primary key default gen_random_uuid(),
  name         text not null default 'Inbound webhook',
  token        text not null unique
               default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  -- What a POST to this endpoint does:
  --   create_lead     : payload { name, phone, email, message, … } → new lead
  --   fire_automation : enroll payload into `automation_id` directly
  action       text not null default 'create_lead'
               check (action in ('create_lead', 'fire_automation')),
  -- { pipeline_id?, stage_id?, tags?, source?, automation_id? }
  config       jsonb not null default '{}',
  hits         integer not null default 0,
  last_hit_at  timestamptz,
  created_by   uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now()
);

-- ---- Open API keys ------------------------------------------
create table if not exists public.api_keys (
  id           uuid primary key default gen_random_uuid(),
  name         text not null default 'API key',
  key          text not null unique
               default 'arc_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  is_active    boolean not null default true,
  last_used_at timestamptz,
  created_by   uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now()
);

-- ---- Workspace settings (key → value) -----------------------
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- ---- RLS + realtime (single-workspace: any authenticated) ---
do $$
declare t text;
begin
  foreach t in array array[
    'automations', 'automation_steps', 'automation_runs',
    'webhook_endpoints', 'api_keys', 'app_settings'
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
