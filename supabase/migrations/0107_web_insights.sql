-- ============================================================
-- 0107_web_insights.sql
--
-- AI INSIGHTS for Web Analytics.
--
-- The dashboard shows what happened. This stores what a reasoning
-- model made of it: a read on how the site is actually performing,
-- what is costing money, and what to change first.
--
-- Every scan is kept rather than overwritten. Two reasons, and the
-- second is the real one:
--
--   • You can see whether a finding from three weeks ago was ever
--     acted on, or whether the same leak keeps being reported.
--   • The evidence the model reasoned from is stored ON the row.
--     An insight without its numbers is an opinion, and rollups get
--     recomputed — so "conversion fell 40%" has to be checkable
--     against the figures that were true when it was written, not
--     against whatever the table says months later.
-- ============================================================

create table if not exists public.web_insights (
  id             uuid primary key default gen_random_uuid(),
  site           text not null default 'arcai.agency',

  -- The window analysed.
  period_start   date not null,
  period_end     date not null,
  range_days     integer not null default 30,

  -- ---- The read ----
  -- 0-100. Deliberately one number: the panel needs something a person
  -- can glance at, and the detail lives in `findings`.
  health_score   integer check (health_score between 0 and 100),
  -- One sentence. The thing you would say if you had one sentence.
  headline       text not null default '',
  summary        text not null default '',

  -- [{ title, severity, area, evidence, recommendation, impact, effort }]
  -- Severity is about how much it is costing; impact/effort are about
  -- whether to do it. Kept separate because a critical finding that
  -- takes a month is not the thing to start on.
  findings       jsonb not null default '[]',
  quick_wins     jsonb not null default '[]',
  what_is_working jsonb not null default '[]',
  watch_list     jsonb not null default '[]',

  -- ---- Provenance ----
  -- The whole evidence bundle handed to the model.
  metrics        jsonb not null default '{}',
  model          text not null default '',
  -- 'complete' | 'failed'. A failed row is kept so the panel can say
  -- what went wrong instead of silently showing the previous scan.
  status         text not null default 'complete'
                 check (status in ('complete', 'failed')),
  error          text,
  duration_ms    integer,

  created_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now()
);

create index if not exists web_insights_recent_idx
  on public.web_insights (site, created_at desc);

-- ---- RLS ----------------------------------------------------
alter table public.web_insights enable row level security;

do $$
begin
  begin
    create policy "web_insights: read all" on public.web_insights
      for select to authenticated using (true);
  exception when duplicate_object then null; end;
  begin
    create policy "web_insights: insert all" on public.web_insights
      for insert to authenticated with check (true);
  exception when duplicate_object then null; end;
  begin
    create policy "web_insights: update all" on public.web_insights
      for update to authenticated using (true) with check (true);
  exception when duplicate_object then null; end;
  begin
    create policy "web_insights: delete all" on public.web_insights
      for delete to authenticated using (true);
  exception when duplicate_object then null; end;
end $$;

do $$
begin
  begin
    alter publication supabase_realtime add table public.web_insights;
  exception when others then null; end;
end $$;
