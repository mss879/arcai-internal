-- ============================================================
-- 0037_lead_research.sql
-- AI prospect research: when a lead lands in the CRM with a
-- company name, the app searches the web through Firecrawl
-- (LinkedIn company page, Google results, recent news, the
-- company's own site), then OpenAI condenses everything into a
-- briefing report — overview, competitors, pain points, talking
-- points — so the team walks into the first call prepared.
--
--   * lead_research — one report per lead (re-running research
--     overwrites it). status walks pending → running → done |
--     error; the automation tick retries rows that got stuck
--     when a serverless function timed out mid-run.
--   * report jsonb holds the structured briefing; sources jsonb
--     lists every page the research actually read.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ---- Research reports ---------------------------------------
create table if not exists public.lead_research (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  company_name text not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'error')),
  error text,
  sources jsonb not null default '[]',
  report jsonb not null default '{}',
  requested_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One live report per lead — re-running research overwrites it.
create unique index if not exists lead_research_lead_idx
  on public.lead_research (lead_id);

-- Fast scan for "queued or stuck" rows on every automation tick.
create index if not exists lead_research_pending_idx
  on public.lead_research (updated_at)
  where status in ('pending', 'running');

drop trigger if exists lead_research_set_updated_at on public.lead_research;
create trigger lead_research_set_updated_at
  before update on public.lead_research
  for each row execute function public.set_updated_at();

-- ---- Row level security + realtime --------------------------
do $$
declare t text;
begin
  foreach t in array array['lead_research'] loop
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
