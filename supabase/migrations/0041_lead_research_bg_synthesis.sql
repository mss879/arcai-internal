-- ============================================================
-- 0041_lead_research_bg_synthesis.sql
-- Prospect research now runs the slow OpenAI synthesis in a Netlify
-- Background Function (15-min budget) so a reasoning model (gpt-5.4-mini)
-- can finish no matter how long it thinks — the ~26s regular-function
-- limit no longer truncates it.
--
-- The state machine becomes (branding + the website audit are on-demand
-- now, so they're no longer pipeline steps):
--   pending -> discovered -> analyzed -> synthesizing -> done | error
--     (local dev synthesizes inline and skips 'synthesizing')
--
-- Coordination rides in the existing `analysis` jsonb: the app stores
-- `synthPrompt` + `synthStartedAt`, the background worker writes back
-- `aiRaw` (or `aiError`), and the tick assembles the final `report`.
-- No new columns.
--
-- Idempotent: safe to re-run.
-- ============================================================

alter table public.lead_research
  drop constraint if exists lead_research_status_check;

alter table public.lead_research
  add constraint lead_research_status_check
  check (
    status in (
      'pending', 'running', 'discovered', 'analyzed', 'audited',
      'synthesizing', 'done', 'error'
    )
  );

-- The tick scans for claimable, non-terminal rows every minute — include
-- 'synthesizing' so a report waiting on the background worker is polled and
-- assembled once the model output lands. ('audited' stays for any legacy
-- in-flight rows from the previous pipeline.)
drop index if exists lead_research_pending_idx;
create index if not exists lead_research_pending_idx
  on public.lead_research (updated_at)
  where status in (
    'pending', 'running', 'discovered', 'analyzed', 'audited', 'synthesizing'
  );
