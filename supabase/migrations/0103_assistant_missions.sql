-- ============================================================
-- 0103_assistant_missions.sql
--
-- MISSIONS — give Arcus a goal, not a command.
--
-- "Chase every overdue invoice." "Get the Musa kickoff ready."
-- One sentence that means eight steps across four areas of the
-- app. Until now the assistant could do any ONE of those steps
-- if you asked for it precisely; a mission is the app doing the
-- whole errand and telling you when it is done.
--
-- The shape is deliberately suggest-then-approve at BOTH ends:
--
--   1. Arcus drafts a PLAN and shows it. Nothing runs until a
--      person taps Approve — the plan is a card, and approval
--      is an HTTP route the model cannot reach, exactly like
--      the send routes.
--
--   2. While running, any step that would reach a client stops
--      at an APPROVAL instead. The tools already produce a
--      confirm card rather than sending; a mission simply
--      persists that card into assistant_approvals for the tray
--      instead of dropping it into a stream nobody is watching.
--      The two send routes remain the only code that sends, and
--      they still require a browser session with the user's own
--      cookie. A mission running on a cron cannot reach them.
--
--   • ASSISTANT_MISSIONS — the goal, the plan (jsonb: one entry
--     per step with its own status), and a `due_at` LEASE
--     cursor: a tick claims a mission by pushing due_at forward
--     three minutes, so a crashed run is retried rather than
--     lost, and two ticks can never drive the same mission.
--
--   • ASSISTANT_APPROVALS — a confirm card, parked. This is the
--     tray badge: "Arcus needs your OK on 2 sends."
--
--   • ASSISTANT_RUN_LOGS — every tool call a mission made, the
--     wa_agent_logs mirror. Autonomy without an audit trail is
--     just a machine doing things you cannot check.
-- ============================================================

-- 1. Missions -------------------------------------------------
create table if not exists public.assistant_missions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  -- The conversation the mission narrates itself into, so its progress
  -- appears in Studio like any other thread.
  thread_id   text references public.assistant_threads (id) on delete set null,
  title       text not null,
  goal        text not null,
  -- [{n, title, status: pending|running|done|failed|skipped, note}]
  plan        jsonb not null default '[]'::jsonb,
  status      text not null default 'proposed'
              check (status in (
                'proposed', 'approved', 'running', 'waiting_approval',
                'paused', 'completed', 'failed', 'cancelled'
              )),
  -- Lease cursor (drainOneAgentRun pattern): null = not queued.
  due_at      timestamptz,
  attempts    int not null default 0,
  steps_done  int not null default 0,
  max_steps   int not null default 20,
  result      jsonb,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists assistant_missions_due_idx
  on public.assistant_missions (due_at)
  where due_at is not null;

create index if not exists assistant_missions_user_idx
  on public.assistant_missions (user_id, created_at desc);

-- 2. Approvals ------------------------------------------------
create table if not exists public.assistant_approvals (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  mission_id uuid references public.assistant_missions (id) on delete cascade,
  thread_id  text references public.assistant_threads (id) on delete set null,
  kind       text not null check (kind in ('invoice_email', 'sms')),
  -- The exact AssistantCard the tool produced, stored verbatim so the tray
  -- renders it with the same component the transcript uses.
  card       jsonb not null,
  status     text not null default 'pending'
             check (status in ('pending', 'sent', 'declined', 'failed', 'expired')),
  error      text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  -- A week-old draft is stale: prices move, situations change.
  expires_at timestamptz not null default now() + interval '7 days'
);

create index if not exists assistant_approvals_pending_idx
  on public.assistant_approvals (user_id, created_at desc)
  where status = 'pending';

-- 3. Run log --------------------------------------------------
create table if not exists public.assistant_run_logs (
  id         uuid primary key default gen_random_uuid(),
  mission_id uuid references public.assistant_missions (id) on delete cascade,
  tool       text not null,
  args       jsonb not null default '{}'::jsonb,
  ok         boolean not null default true,
  result     text,
  created_at timestamptz not null default now()
);

create index if not exists assistant_run_logs_mission_idx
  on public.assistant_run_logs (mission_id, created_at);

-- 4. updated_at trigger ---------------------------------------
drop trigger if exists assistant_missions_set_updated_at on public.assistant_missions;
create trigger assistant_missions_set_updated_at
  before update on public.assistant_missions
  for each row execute function public.set_updated_at();

-- 5. RLS — own rows only --------------------------------------
alter table public.assistant_missions  enable row level security;
alter table public.assistant_approvals enable row level security;
alter table public.assistant_run_logs  enable row level security;

drop policy if exists "assistant_missions_own" on public.assistant_missions;
create policy "assistant_missions_own" on public.assistant_missions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "assistant_approvals_own" on public.assistant_approvals;
create policy "assistant_approvals_own" on public.assistant_approvals
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- The log is readable by the owner of the mission it belongs to; writes come
-- from the tick's service-role client.
drop policy if exists "assistant_run_logs_read" on public.assistant_run_logs;
create policy "assistant_run_logs_read" on public.assistant_run_logs
  for select using (
    exists (
      select 1 from public.assistant_missions m
      where m.id = assistant_run_logs.mission_id
        and m.user_id = auth.uid()
    )
  );

-- 6. Realtime (0021 guard pattern) ----------------------------
-- The mission trail and the approvals badge both move without a reload.
do $$
declare
  t text;
begin
  foreach t in array array['assistant_missions', 'assistant_approvals'] loop
    begin
      execute format(
        'alter publication supabase_realtime add table public.%I', t
      );
    exception
      when duplicate_object then null; -- already published
      when others then null;           -- e.g. publication is FOR ALL TABLES
    end;
  end loop;
end $$;
