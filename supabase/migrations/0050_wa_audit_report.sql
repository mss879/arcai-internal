-- ============================================================
-- 0050_wa_audit_report.sql
-- Showcase upgrade: a detailed branded PDF audit report (mobile +
-- desktop Lighthouse, SEO, accessibility, on-page checks) rendered
-- in a new `reporting` pipeline step and delivered on WhatsApp as a
-- document, right after the redesign mockup image.
--
--   pending → reporting → rendering → ready → sent
--
-- Idempotent: safe to re-run.
-- ============================================================

alter table public.wa_showcases
  drop constraint if exists wa_showcases_status_check;
alter table public.wa_showcases
  add constraint wa_showcases_status_check check (status in (
    'pending',     -- gather: mobile Lighthouse + context + before shot
    'reporting',   -- desktop Lighthouse + on-page SEO + render the PDF
    'rendering',   -- Nano Banana 2 redesign mockup
    'ready',       -- deliver: image + PDF document + text
    'sent',
    'error'
  ));

alter table public.wa_showcases
  add column if not exists report_pdf_url text;

-- The claimable partial index must cover the new in-flight status.
drop index if exists wa_showcases_claimable_idx;
create index if not exists wa_showcases_claimable_idx
  on public.wa_showcases (updated_at)
  where status in ('pending', 'reporting', 'rendering', 'ready');
