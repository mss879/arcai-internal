-- ============================================================
-- 0039_lead_research_deep.sql
-- Upgrades prospect research into a multi-step "agency dossier"
-- pipeline: it crawls the company site for its brand system
-- (colours, fonts, spacing, logo — via Firecrawl's branding
-- extraction), maps its pages and social presence, scrapes a top
-- competitor for a real side-by-side, then has AI write the
-- briefing.
--
-- Because that work far exceeds one serverless timeout, it runs
-- as a state machine the automation tick advances ONE step per
-- minute:
--   pending -> discovered -> analyzed -> done | error
--
--   * analysis  jsonb — intermediate data carried between steps
--     (brand, social links, page map, competitor context, the
--     scraped content the final AI step summarises).
--   * locked_at timestamptz — a short lease so two ticks can't
--     process the same row's step at once; a lease older than a
--     couple of minutes is considered dead and reclaimed.
--
-- Idempotent: safe to re-run.
-- ============================================================

alter table public.lead_research
  add column if not exists analysis jsonb not null default '{}';

alter table public.lead_research
  add column if not exists locked_at timestamptz;

-- Widen the status check to the new pipeline states (keep the old
-- ones so existing rows stay valid).
alter table public.lead_research
  drop constraint if exists lead_research_status_check;

alter table public.lead_research
  add constraint lead_research_status_check
  check (status in ('pending', 'running', 'discovered', 'analyzed', 'done', 'error'));

-- The tick scans for claimable, non-terminal rows every minute.
drop index if exists lead_research_pending_idx;
create index if not exists lead_research_pending_idx
  on public.lead_research (updated_at)
  where status in ('pending', 'running', 'discovered', 'analyzed');
