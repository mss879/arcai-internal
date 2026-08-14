-- ============================================================
-- 0073_wa_insights_lessons.sql
-- WhatsApp sales machine — the learning loop, made accountable:
--
--   wa_convo_insights : one scored row per ENDED conversation
--                       (48h of silence, or the lead closing,
--                       ends it). A nightly batch job reads the
--                       thread and extracts outcome, objections,
--                       buying signals, FAQ gaps and reply-quality
--                       flags. Powers the Analytics tab AND
--                       supplies the evidence the lesson miner
--                       learns from. A booked call counts as the
--                       AGENT'S WIN — the agent's job ends at the
--                       booked call; the deal closing is the
--                       team's half.
--
--   wa_lessons        : the approve-first queue. Mined lessons
--                       (nightly miner + the weekly coach) land
--                       here as `pending`; ONLY team-approved
--                       rows reach the live system prompt. This
--                       replaces wa_coaching's auto-applied
--                       bullets — the coach still writes its
--                       weekly row, but its bullets now queue
--                       here for review instead of self-applying.
-- ============================================================

-- ---- Scored conversations --------------------------------------
create table if not exists public.wa_convo_insights (
  id              uuid primary key default gen_random_uuid(),
  contact_id      uuid not null references public.wa_contacts (id) on delete cascade,
  campaign_id     uuid references public.wa_campaigns (id) on delete set null,
  lead_id         uuid references public.leads (id) on delete set null,
  -- When the conversation crossed the "ended" line (48h silence / lead closed).
  convo_ended_at  timestamptz not null,
  status          text not null default 'pending'
                  check (status in ('pending', 'scored', 'failed')),
  -- 'call_booked' and 'won' are the agent's wins; the rest are the lessons.
  outcome         text
                  check (outcome in ('won', 'call_booked', 'quoted_pending', 'open', 'ghosted', 'declined', 'lost')),
  stage_reached   text,
  objections      text[] not null default '{}',
  questions_asked text[] not null default '{}',
  buying_signals  text[] not null default '{}',
  -- Questions the agent couldn't answer ("let me get the team to confirm").
  faq_gaps        text[] not null default '{}',
  -- Reply-rule violations spotted in the agent's own messages
  -- (asterisks, wall_of_text, no_closing_question, missed_buying_signal, repeated_greeting).
  quality_flags   text[] not null default '{}',
  language        text,
  messages_in     int not null default 0,
  messages_out    int not null default 0,
  summary         text,
  attempts        int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- A revived-then-re-ended thread earns a fresh row; the same ending never two.
  unique (contact_id, convo_ended_at)
);

create index if not exists wa_convo_insights_pending_idx
  on public.wa_convo_insights (created_at) where status = 'pending';
create index if not exists wa_convo_insights_recent_idx
  on public.wa_convo_insights (created_at desc);

drop trigger if exists wa_convo_insights_set_updated_at on public.wa_convo_insights;
create trigger wa_convo_insights_set_updated_at
  before update on public.wa_convo_insights
  for each row execute function public.set_updated_at();

-- ---- The approve-first lesson queue ----------------------------
create table if not exists public.wa_lessons (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null
              check (kind in ('objection_rebuttal', 'faq', 'phrasing', 'playbook')),
  title       text not null,
  -- The exact text injected into the prompt (or knowledge base, for 'faq') once approved.
  body        text not null,
  -- Persisted proof: insight ids, verbatim snippets, counts — reviewable forever.
  evidence    jsonb not null default '{}'::jsonb,
  source      text not null default 'nightly_miner'
              check (source in ('nightly_miner', 'weekly_coach', 'manual')),
  status      text not null default 'pending'
              check (status in ('pending', 'approved', 'rejected')),
  decided_by  uuid references public.profiles (id) on delete set null,
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists wa_lessons_pending_idx
  on public.wa_lessons (created_at desc) where status = 'pending';
create index if not exists wa_lessons_status_idx
  on public.wa_lessons (status, decided_at desc);

drop trigger if exists wa_lessons_set_updated_at on public.wa_lessons;
create trigger wa_lessons_set_updated_at
  before update on public.wa_lessons
  for each row execute function public.set_updated_at();

-- ---- Nightly-job claim stamps (coaching_ran_for pattern) -------
alter table public.wa_agent_config
  add column if not exists insights_ran_for date;
alter table public.wa_agent_config
  add column if not exists lessons_ran_for date;

-- ---- RLS + realtime (single-workspace: any authenticated) ----
do $$
declare t text;
begin
  foreach t in array array['wa_convo_insights', 'wa_lessons'] loop
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
