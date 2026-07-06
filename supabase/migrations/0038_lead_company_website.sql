-- ============================================================
-- 0038_lead_company_website.sql
-- A dedicated company website on each lead. It anchors AI
-- prospect research to the RIGHT company: given the real domain
-- the researcher scrapes the site directly and validates every
-- other source against that domain, instead of guessing from a
-- name that may match a different company.
--
-- Idempotent: safe to re-run.
-- ============================================================

alter table public.leads
  add column if not exists company_website text;
