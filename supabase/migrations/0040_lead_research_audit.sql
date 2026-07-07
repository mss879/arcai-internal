-- ============================================================
-- 0040_lead_research_audit.sql
-- Adds a fourth pipeline step to prospect research: a website
-- AUDIT (Google PageSpeed / Lighthouse scorecard + domain age via
-- RDAP) that runs between the competitor analysis and the final
-- AI dossier. This isolates the slow PageSpeed call into its own
-- serverless step so each step still fits the function budget.
--
-- The state machine becomes:
--   pending -> discovered -> analyzed -> audited -> done | error
--
-- No new columns: the audit result rides in the existing `analysis`
-- jsonb between steps and lands in the `report` jsonb at the end.
-- This migration only widens the status CHECK + the pending index.
--
-- Idempotent: safe to re-run.
-- ============================================================

alter table public.lead_research
  drop constraint if exists lead_research_status_check;

alter table public.lead_research
  add constraint lead_research_status_check
  check (
    status in (
      'pending', 'running', 'discovered', 'analyzed', 'audited', 'done', 'error'
    )
  );

-- The tick scans for claimable, non-terminal rows every minute — include
-- the new 'audited' state so a report waiting on its final step is picked up.
drop index if exists lead_research_pending_idx;
create index if not exists lead_research_pending_idx
  on public.lead_research (updated_at)
  where status in ('pending', 'running', 'discovered', 'analyzed', 'audited');
