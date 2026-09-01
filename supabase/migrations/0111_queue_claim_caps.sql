-- 0111 — bound interrupted retries on the queue pipelines.
--
-- Every queue worker (research, prospecting, carousels, outreach drafting)
-- claims a row by stamping `locked_at` and commits fenced on that token. A
-- thrown error already parks the row. But a worker KILLED by the platform —
-- the serverless timeout — never reaches its catch: the lease simply expires
-- and the next tick claims the row again and repeats the same paid step
-- (a Firecrawl scrape, a Lighthouse pass, a model call) — potentially
-- forever. That loop is exactly what ran the Netlify bill up.
--
-- `claims` counts CONSECUTIVE claims without committed progress. The worker
-- bumps it at claim time (kill-proof: the bump lands before the step runs)
-- and resets it to 0 on every committed step and every healthy release. A
-- row claimed too many times in a row without progress is parked terminally
-- for a human to re-queue.
--
-- All statements are `if not exists` — safe to run twice.

alter table public.lead_research
  add column if not exists claims integer not null default 0;

alter table public.prospect_scans
  add column if not exists claims integer not null default 0;

alter table public.carousel_posts
  add column if not exists claims integer not null default 0;

alter table public.lead_outreach
  add column if not exists claims integer not null default 0;
