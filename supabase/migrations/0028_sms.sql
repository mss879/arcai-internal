-- ============================================================
-- 0028_sms.sql
-- SMS via Notify.lk — custom messages, payment reminders and
-- timer-based automation workflows (a make.com-style builder).
--
--   sms_workflows      : a named automation (e.g. "New client welcome")
--   sms_workflow_steps : ordered steps — send an SMS or wait a timer
--   sms_workflow_runs  : one enrollment of a contact into a workflow;
--                        next_run_at drives the timers
--   sms_messages       : log of every SMS the app has sent (custom,
--                        payment reminder or automation)
--
-- Shared across the workspace, mirroring proposals (0023).
-- ============================================================

-- ---- Workflows ----------------------------------------------
create table if not exists public.sms_workflows (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default 'Untitled workflow',
  -- Inactive workflows don't fire: enrollments are blocked and any
  -- running enrollments pause until the workflow is switched back on.
  is_active   boolean not null default true,
  created_by  uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists sms_workflows_created_at_idx
  on public.sms_workflows (created_at desc);

create or replace function public.set_sms_workflows_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists sms_workflows_set_updated_at on public.sms_workflows;
create trigger sms_workflows_set_updated_at
  before update on public.sms_workflows
  for each row execute function public.set_sms_workflows_updated_at();

-- ---- Workflow steps -----------------------------------------
create table if not exists public.sms_workflow_steps (
  id            uuid primary key default gen_random_uuid(),
  workflow_id   uuid not null references public.sms_workflows (id) on delete cascade,
  -- 0-based order the steps execute in.
  position      integer not null default 0,
  -- send_sms : sends `message` (supports {{name}} / {{full_name}})
  -- wait     : pauses the run for `wait_minutes`
  kind          text not null default 'send_sms'
                check (kind in ('send_sms', 'wait')),
  message       text not null default '',
  wait_minutes  integer not null default 0 check (wait_minutes >= 0),
  created_at    timestamptz not null default now()
);

create index if not exists sms_workflow_steps_workflow_idx
  on public.sms_workflow_steps (workflow_id, position);

-- ---- Workflow runs (enrollments) ----------------------------
create table if not exists public.sms_workflow_runs (
  id            uuid primary key default gen_random_uuid(),
  workflow_id   uuid not null references public.sms_workflows (id) on delete cascade,
  client_id     uuid references public.clients (id) on delete set null,
  -- Snapshot so the run stays readable if the client is deleted.
  client_name   text not null default '',
  -- Recipient in Notify.lk format (9471XXXXXXX).
  to_number     text not null,
  -- Index of the next step to execute.
  step_index    integer not null default 0,
  status        text not null default 'running'
                check (status in ('running', 'completed', 'cancelled', 'failed')),
  -- When the run is next due. Timers work by pushing this forward.
  next_run_at   timestamptz not null default now(),
  error         text,
  created_by    uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);

create index if not exists sms_workflow_runs_due_idx
  on public.sms_workflow_runs (status, next_run_at);
create index if not exists sms_workflow_runs_workflow_idx
  on public.sms_workflow_runs (workflow_id, created_at desc);

-- ---- Message log --------------------------------------------
create table if not exists public.sms_messages (
  id           uuid primary key default gen_random_uuid(),
  -- Recipient in Notify.lk format (9471XXXXXXX).
  to_number    text not null,
  message      text not null,
  client_id    uuid references public.clients (id) on delete set null,
  client_name  text not null default '',
  -- Where the SMS came from:
  --   custom           : composed by hand on the Send tab
  --   payment_reminder : sent from the Payment Reminders tab
  --   automation       : sent by a workflow step
  kind         text not null default 'custom'
               check (kind in ('custom', 'payment_reminder', 'automation')),
  status       text not null default 'sent'
               check (status in ('sent', 'failed')),
  error        text,
  invoice_id   uuid references public.invoices (id) on delete set null,
  workflow_id  uuid references public.sms_workflows (id) on delete set null,
  segments     integer not null default 1,
  created_by   uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now()
);

create index if not exists sms_messages_created_at_idx
  on public.sms_messages (created_at desc);

-- ---- RLS (single-workspace: any authenticated member) -------
alter table public.sms_workflows enable row level security;
alter table public.sms_workflow_steps enable row level security;
alter table public.sms_workflow_runs enable row level security;
alter table public.sms_messages enable row level security;

create policy "sms_workflows: read all"
  on public.sms_workflows for select to authenticated using (true);
create policy "sms_workflows: write all"
  on public.sms_workflows for insert to authenticated with check (true);
create policy "sms_workflows: update all"
  on public.sms_workflows for update to authenticated using (true) with check (true);
create policy "sms_workflows: delete all"
  on public.sms_workflows for delete to authenticated using (true);

create policy "sms_workflow_steps: read all"
  on public.sms_workflow_steps for select to authenticated using (true);
create policy "sms_workflow_steps: write all"
  on public.sms_workflow_steps for insert to authenticated with check (true);
create policy "sms_workflow_steps: update all"
  on public.sms_workflow_steps for update to authenticated using (true) with check (true);
create policy "sms_workflow_steps: delete all"
  on public.sms_workflow_steps for delete to authenticated using (true);

create policy "sms_workflow_runs: read all"
  on public.sms_workflow_runs for select to authenticated using (true);
create policy "sms_workflow_runs: write all"
  on public.sms_workflow_runs for insert to authenticated with check (true);
create policy "sms_workflow_runs: update all"
  on public.sms_workflow_runs for update to authenticated using (true) with check (true);
create policy "sms_workflow_runs: delete all"
  on public.sms_workflow_runs for delete to authenticated using (true);

create policy "sms_messages: read all"
  on public.sms_messages for select to authenticated using (true);
create policy "sms_messages: write all"
  on public.sms_messages for insert to authenticated with check (true);
create policy "sms_messages: update all"
  on public.sms_messages for update to authenticated using (true) with check (true);
create policy "sms_messages: delete all"
  on public.sms_messages for delete to authenticated using (true);

-- ---- Live updates (optional; ignored if FOR ALL TABLES) -----
do $$
begin
  alter publication supabase_realtime add table public.sms_workflows;
exception when others then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.sms_workflow_steps;
exception when others then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.sms_workflow_runs;
exception when others then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.sms_messages;
exception when others then null;
end $$;
