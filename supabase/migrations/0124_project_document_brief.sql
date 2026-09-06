-- ============================================================
-- 0124_project_document_brief.sql
-- What a project's uploaded proposal and invoice say, read into the row.
--
-- A project is created by attaching the signed proposal and the invoice
-- (0083) and then retyping the figures out of them. The invoice already
-- prints "DUE TODAY: Rs. 140,000" and the proposal already lists what was
-- sold, so from now on the app reads them (src/lib/document-brief-reader.ts)
-- and fills in `total_value` and `deposit_required_percent` itself, keeping
-- the full reading here so the team can see where every figure came from.
--
-- Only projects created from 2026-09-01 are read — older ones were set up
-- by hand and carry no proposal. The gate lives in code
-- (DOCUMENT_BRIEF_SINCE); these columns simply stay NULL for them.
-- ============================================================

alter table public.projects
  add column if not exists document_brief         jsonb,
  add column if not exists document_brief_read_at timestamptz;

comment on column public.projects.document_brief is
  'src/lib/document-brief.ts DocumentBrief: pricing read off the invoice, scope '
  'off the proposal, and the warnings a person should look at. Written only by '
  'readProjectDocuments(); the same read also fills total_value and '
  'deposit_required_percent when the documents state them.';
comment on column public.projects.document_brief_read_at is
  'When document_brief was last produced. NULL = never read (or created before '
  'DOCUMENT_BRIEF_SINCE).';
