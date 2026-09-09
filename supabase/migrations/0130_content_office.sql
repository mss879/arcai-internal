-- ============================================================
-- 0130 — Content Office: a multi-agent virtual office for social content
--
-- The Content Studio was one gpt-4o-mini call and a Gemini renderer. This
-- turns it into a team: a Director (gpt-6-astra) that plans and delegates,
-- and seven specialists — research, planning, copy, art direction, brand,
-- QA, publishing — each on its own model, each step an OpenAI Responses call
-- in background mode that is polled, never awaited (Netlify kills a
-- function at ~26s, and a killed model call is paid for with nothing kept).
--
--   office_agents            roster overrides (model, effort, persona)
--   office_brand_profiles    the voice the writers and QA work against
--   office_missions          one goal → one mission (a brief or a schedule)
--   office_tasks             one agent, one unit of work, one lease
--   office_task_transcripts  the raw model transcript — NOT realtime
--   office_events            the live feed the floor animates from
--   office_schedules         timers that open missions unattended
--
-- Cost safety is the whole design, because the September 2026 bill came
-- from killed workers re-claiming expired leases and re-buying model calls:
--   * `openai_response_id` is written BEFORE anything else happens after a
--     create, so a cut-off step polls the same paid response instead of
--     starting another;
--   * `attempts` counts paid starts only (cap 3, backoff); `killed` counts
--     leased steps the platform cut off (cap 3); polling counts as neither;
--   * the ledger is the existing `ai_usage_events`, with `project_id`
--     nullable and `office_task_id` set — internal spend, never invoiced.
--
-- Additive and idempotent. Apply BEFORE deploying the code that uses it;
-- until then the Office renders empty and every other tab is untouched.
-- ============================================================

-- 1. Roster overrides ----------------------------------------------------------
-- The roster itself lives in code (src/lib/agents/roster.ts). A row here
-- overrides one agent's model, effort, persona or name; null = the default.

create table if not exists public.office_agents (
  key              text primary key,
  name             text not null,
  title            text not null default '',
  description      text not null default '',
  model            text,
  reasoning_effort text,
  instructions     text not null default '',
  tools            jsonb not null default '[]'::jsonb,
  enabled          boolean not null default true,
  color            text,
  sort             integer not null default 0,
  updated_by       uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

drop trigger if exists office_agents_set_updated_at on public.office_agents;
create trigger office_agents_set_updated_at
  before update on public.office_agents
  for each row execute function public.set_updated_at();

insert into public.office_agents (key, name, title, sort) values
  ('manager',   'Astra', 'Content Director', 0),
  ('research',  'Scout', 'Researcher',       1),
  ('planner',   'Grid',  'Content Planner',  2),
  ('writer',    'Quill', 'Copywriter',       3),
  ('designer',  'Pixel', 'Art Director',     4),
  ('brand',     'Tone',  'Brand Guardian',   5),
  ('qa',        'Audit', 'Quality Checker',  6),
  ('publisher', 'Relay', 'Publisher',        7)
on conflict (key) do nothing;

-- 2. Brand profiles ------------------------------------------------------------
-- client_id null = the agency's own (house) brand.

create table if not exists public.office_brand_profiles (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid references public.clients (id) on delete cascade,
  name          text not null,
  voice         jsonb not null default '{}'::jsonb,
  pillars       text[] not null default '{}',
  audience      text not null default '',
  banned_words  text[] not null default '{}',
  hashtag_sets  jsonb not null default '[]'::jsonb,
  colors        jsonb not null default '[]'::jsonb,
  notes         text not null default '',
  is_default    boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists office_brand_profiles_client_key
  on public.office_brand_profiles (client_id) where client_id is not null;

drop trigger if exists office_brand_profiles_set_updated_at on public.office_brand_profiles;
create trigger office_brand_profiles_set_updated_at
  before update on public.office_brand_profiles
  for each row execute function public.set_updated_at();

insert into public.office_brand_profiles (client_id, name, voice, pillars, audience, notes, is_default)
select
  null,
  'ARC AI — house brand',
  '{"tone":["confident","warm","plain-spoken"],"persona":"a Sri Lankan digital agency that builds AI-powered systems for small and medium businesses","do":["lead with the outcome for the reader","use concrete numbers and examples","short sentences, British English"],"dont":["hype words like revolutionary or game-changing","jargon without a plain explanation","walls of emoji"]}'::jsonb,
  array['AI automation for SMEs', 'Websites and apps that convert', 'Client results', 'Behind the scenes at the agency'],
  'Owners and marketing leads of Sri Lankan SMEs deciding whether to bring AI into their business',
  '',
  true
where not exists (
  select 1 from public.office_brand_profiles where client_id is null and is_default
);

-- 3. Missions -------------------------------------------------------------------

create table if not exists public.office_missions (
  id               uuid primary key default gen_random_uuid(),
  title            text not null default '',
  goal             text not null,
  mode             text not null default 'manager'
                   check (mode in ('manager', 'direct')),
  status           text not null default 'planning'
                   check (status in ('planning', 'running', 'review', 'approved', 'done', 'failed', 'cancelled', 'paused')),
  plan             jsonb not null default '{}'::jsonb,
  summary          jsonb not null default '{}'::jsonb,
  options          jsonb not null default '{}'::jsonb,
  client_id        uuid references public.clients (id) on delete set null,
  brand_profile_id uuid references public.office_brand_profiles (id) on delete set null,
  cost_usd         numeric(12,6) not null default 0,
  revision_round   integer not null default 0,
  error            text,
  created_by       uuid references public.profiles (id) on delete set null,
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists office_missions_status_idx
  on public.office_missions (status, updated_at desc);
create index if not exists office_missions_created_idx
  on public.office_missions (created_at desc);

drop trigger if exists office_missions_set_updated_at on public.office_missions;
create trigger office_missions_set_updated_at
  before update on public.office_missions
  for each row execute function public.set_updated_at();

-- 4. Tasks -----------------------------------------------------------------------
-- Small on purpose: this row is realtime-published and every change of it is
-- a payload. The transcript lives in its own table below.

create table if not exists public.office_tasks (
  id                 uuid primary key default gen_random_uuid(),
  mission_id         uuid not null references public.office_missions (id) on delete cascade,
  key                text not null,
  agent_key          text not null,
  kind               text not null default 'work'
                     check (kind in ('plan', 'work', 'review', 'revise')),
  title              text not null,
  instructions       text not null default '',
  depends_on         uuid[] not null default '{}',
  status             text not null default 'queued'
                     check (status in ('queued', 'ready', 'running', 'done', 'failed', 'cancelled', 'blocked')),
  phase              text not null default '',
  step               text not null default '',
  input              jsonb not null default '{}'::jsonb,
  output             jsonb,
  attempts           integer not null default 0,
  rounds             integer not null default 0,
  version            integer not null default 0,
  lease_until        timestamptz,
  killed             integer not null default 0,
  run_after          timestamptz,
  openai_response_id text,
  response_started_at timestamptz,
  pending_create_at  timestamptz,
  model              text,
  effort             text,
  model_note         text,
  usage_input        integer not null default 0,
  usage_cached       integer not null default 0,
  usage_output       integer not null default 0,
  usage_reasoning    integer not null default 0,
  tool_calls         integer not null default 0,
  searches           integer not null default 0,
  cost_usd           numeric(12,6) not null default 0,
  revision_of        uuid references public.office_tasks (id) on delete set null,
  revision_round     integer not null default 0,
  error              text,
  started_at         timestamptz,
  finished_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (mission_id, key)
);

create index if not exists office_tasks_status_idx
  on public.office_tasks (status, run_after);
create index if not exists office_tasks_mission_idx
  on public.office_tasks (mission_id, created_at);
create index if not exists office_tasks_response_idx
  on public.office_tasks (openai_response_id) where openai_response_id is not null;

drop trigger if exists office_tasks_set_updated_at on public.office_tasks;
create trigger office_tasks_set_updated_at
  before update on public.office_tasks
  for each row execute function public.set_updated_at();

-- 5. Transcripts (not published) ---------------------------------------------------

create table if not exists public.office_task_transcripts (
  task_id    uuid primary key references public.office_tasks (id) on delete cascade,
  items      jsonb not null default '[]'::jsonb,
  responses  jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

drop trigger if exists office_task_transcripts_set_updated_at on public.office_task_transcripts;
create trigger office_task_transcripts_set_updated_at
  before update on public.office_task_transcripts
  for each row execute function public.set_updated_at();

-- 6. Events — the live feed ---------------------------------------------------------

create table if not exists public.office_events (
  id         bigserial primary key,
  mission_id uuid references public.office_missions (id) on delete cascade,
  task_id    uuid references public.office_tasks (id) on delete cascade,
  agent_key  text not null,
  kind       text not null
             check (kind in ('started', 'thinking', 'search', 'tool', 'handoff', 'done', 'failed', 'blocked', 'revision', 'review', 'note', 'schedule')),
  message    text not null,
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists office_events_created_idx
  on public.office_events (created_at desc);
create index if not exists office_events_mission_idx
  on public.office_events (mission_id, id);

-- 7. Schedules — timers ---------------------------------------------------------------

create table if not exists public.office_schedules (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  goal             text not null,
  mode             text not null default 'manager'
                   check (mode in ('manager', 'direct')),
  agent_key        text,
  cadence          text not null default 'weekly'
                   check (cadence in ('daily', 'weekly', 'monthly', 'every_n_days')),
  every_n          integer,
  run_time         time not null default '09:00',
  weekdays         integer[] not null default '{}',
  day_of_month     integer,
  timezone         text not null default 'Asia/Colombo',
  options          jsonb not null default '{}'::jsonb,
  client_id        uuid references public.clients (id) on delete set null,
  brand_profile_id uuid references public.office_brand_profiles (id) on delete set null,
  is_active        boolean not null default true,
  next_run_at      timestamptz,
  last_run_at      timestamptz,
  last_mission_id  uuid references public.office_missions (id) on delete set null,
  created_by       uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists office_schedules_due_idx
  on public.office_schedules (is_active, next_run_at);

drop trigger if exists office_schedules_set_updated_at on public.office_schedules;
create trigger office_schedules_set_updated_at
  before update on public.office_schedules
  for each row execute function public.set_updated_at();

-- A mission remembers which timer opened it (added after both tables exist).
alter table public.office_missions
  add column if not exists schedule_id uuid references public.office_schedules (id) on delete set null;

-- 8. Links into the existing content pipeline ---------------------------------------

alter table public.carousel_posts
  add column if not exists mission_id uuid references public.office_missions (id) on delete set null,
  add column if not exists office_task_id uuid references public.office_tasks (id) on delete set null;

create index if not exists carousel_posts_mission_idx
  on public.carousel_posts (mission_id) where mission_id is not null;

-- 9. The usage ledger learns about internal spend ------------------------------------
-- Every reader of ai_usage_events filters by an explicit project (the rollup
-- RPC, the billing pass, the /ai-projects pages), so a row with a null
-- project_id can never reach a client's invoice. The check keeps every row
-- owned by something.

alter table public.ai_usage_events alter column project_id drop not null;

alter table public.ai_usage_events
  add column if not exists office_task_id uuid references public.office_tasks (id) on delete set null;

alter table public.ai_usage_events drop constraint if exists ai_usage_events_purpose_check;
alter table public.ai_usage_events add constraint ai_usage_events_purpose_check
  check (purpose in ('reply', 'retrieval', 'ingest', 'describe', 'agent'));

do $$
begin
  alter table public.ai_usage_events add constraint ai_usage_events_owner_check
    check (project_id is not null or office_task_id is not null);
exception
  when duplicate_object then null;
end $$;

create index if not exists ai_usage_events_office_idx
  on public.ai_usage_events (day) where project_id is null;

-- 10. The Director's model ------------------------------------------------------------
-- OpenAI list price read on 2026-09-09; released 2026-09-03. Tool calling on
-- this model requires the Responses API.

insert into public.ai_model_prices
  (model, kind, label, input_per_m, cached_input_per_m, output_per_m, effective_from, effective_to, note)
values
  ('gpt-6-astra', 'chat', 'GPT-6 Astra', 10.00, 1.00, 50.00, '2026-09-03', null,
   'Released 2026-09-03 · tool calling requires the Responses API')
on conflict (model, effective_from) do nothing;

-- 11. The approvals badge counts missions waiting for a decision -----------------------
-- Same body as 0120's plus the new queue. security invoker, so the read policy
-- in §13 is what lets the count see the rows.

create or replace function public.approvals_count()
returns int
language sql
stable
security invoker
set search_path = public
as $$
  select
    (select count(*) from public.assistant_approvals where status = 'pending')
  + (select count(*) from public.member_loans where approval = 'pending')
  + (select count(*) from public.commissions where status = 'pending')
  + (select count(*) from public.wa_lessons where status = 'pending')
  + (select count(*) from public.lead_outreach where status = 'ready')
  + (select count(*) from public.project_change_requests
       where status in ('new', 'quoted'))
  + (select count(*) from public.carousel_posts
       where status = 'ready' and chosen_option_id is null)
  -- 0120
  + (select count(*) from public.payment_slips where status in ('pending', 'duplicate'))
  -- 0130
  + (select count(*) from public.office_missions where status = 'review');
$$;

-- 12. Audit trail on the config tables ------------------------------------------------
-- Runs are machine-written and would drown the Team feed; config edits are
-- the ones a person made.

do $$
declare t text;
begin
  if to_regproc('public.log_member_change') is null then return; end if;
  foreach t in array array['office_agents', 'office_brand_profiles', 'office_schedules'] loop
    execute format('drop trigger if exists member_changes_audit on public.%I', t);
    execute format(
      'create trigger member_changes_audit after insert or update or delete on public.%I for each row execute function public.log_member_change()',
      t
    );
  end loop;
end $$;

-- 13. RLS ------------------------------------------------------------------------------
-- Config (agents, brand, schedules): anyone signed in may read, admins write —
-- a model choice is a cost and a schedule can publish.
-- Runs (missions, tasks, events): anyone signed in may read; NOBODY writes
-- through the anon key. Every write is a server action on the service role
-- behind assertCapability('marketing'), because a task row is a paid model
-- call and the anon key ships to the browser (0129).
-- Transcripts: admins only — they carry raw web text.

do $$
declare t text;
begin
  foreach t in array array[
    'office_agents', 'office_brand_profiles', 'office_missions', 'office_tasks',
    'office_task_transcripts', 'office_events', 'office_schedules'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array['office_agents', 'office_brand_profiles', 'office_schedules'] loop
    begin
      execute format(
        'create policy "%s: read all" on public.%I for select to authenticated using (true)', t, t);
    exception when duplicate_object then null; end;
    begin
      execute format(
        'create policy "%s: admin write" on public.%I for all to authenticated using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()))', t, t);
    exception when duplicate_object then null; end;
  end loop;

  foreach t in array array['office_missions', 'office_tasks', 'office_events'] loop
    begin
      execute format(
        'create policy "%s: read all" on public.%I for select to authenticated using (true)', t, t);
    exception when duplicate_object then null; end;
  end loop;

  begin
    create policy "office_task_transcripts: admin read" on public.office_task_transcripts
      for select to authenticated using (public.is_admin(auth.uid()));
  exception when duplicate_object then null; end;
end $$;

-- 14. Realtime — the floor animates from these three ------------------------------------

do $$
declare t text;
begin
  foreach t in array array['office_missions', 'office_tasks', 'office_events'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;
      when others then null;
    end;
  end loop;
end $$;

-- 15. Record ------------------------------------------------------------------------------

insert into public.schema_migrations (version, note)
values ('0130_content_office', 'Content Office: office_* tables, gpt-6-astra price, usage ledger accepts internal spend')
on conflict (version) do nothing;
