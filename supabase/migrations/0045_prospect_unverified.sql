-- ============================================================
-- 0045_prospect_unverified.sql
-- Prospecting accuracy: a site that is UP but can't be analyzed
-- (bot-protected / non-HTML) is now honestly marked 'unverified'
-- instead of being guessed at. Part of the verification ladder
-- that also stops live sites being called "down" (a verdict of
-- 'broken' now requires Firecrawl AND a direct HTTP probe to
-- both fail — see src/lib/ai/site-probe.ts).
--
-- Idempotent: safe to re-run.
-- ============================================================

alter table public.prospect_candidates
  drop constraint if exists prospect_candidates_website_verdict_check;

alter table public.prospect_candidates
  add constraint prospect_candidates_website_verdict_check
  check (website_verdict in (
    'pending', 'no_website', 'facebook_only', 'bad_website',
    'broken', 'good_website', 'excluded', 'duplicate', 'unverified'
  ));
