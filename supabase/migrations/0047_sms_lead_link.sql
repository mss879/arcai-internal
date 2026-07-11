-- ============================================================
-- 0047_sms_lead_link.sql
-- Voice assistant SMS → CRM linkage. prepare_sms now falls back
-- to the CRM pipeline (leads.contact_phone) when no saved client
-- matches the name, so the SMS log records which lead a text went
-- to. The send route also writes a lead_activities 'sms' entry so
-- the text shows on the lead's timeline.
-- ============================================================

alter table public.sms_messages
  add column if not exists lead_id uuid references public.leads (id) on delete set null;

create index if not exists sms_messages_lead_idx
  on public.sms_messages (lead_id, created_at desc);
