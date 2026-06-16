-- ============================================================
-- 0015_crm_stage_color_orange.sql
-- Change default crm stage color from purple (#6d5cff) to tech orange (#f97316).
-- ============================================================

-- Update defaults
alter table public.pipeline_stages alter column color set default '#f97316';

-- Update existing data
update public.pipeline_stages set color = '#f97316' where color = '#6d5cff';
