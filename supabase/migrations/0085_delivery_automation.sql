-- ============================================================
-- 0085_delivery_automation.sql
--
-- CLIENT DELIVERY HUB — part 2 of 3.
--
-- Teaches the automation engine about delivery:
--
--   • Four new triggers — project_stage_changed (a project's
--     delivery_stage moved), project_delivered (convenience
--     alias fired when the stage lands on 'delivered', so the
--     post-delivery recipes can chain simple waits off it),
--     asset_submitted (a checklist item arrived — via the
--     portal or WhatsApp), assets_complete (the LAST required
--     item landed).
--
--   • Two new steps — start_wa_onboarding (flip the client's
--     WhatsApp thread into asset-collection mode and send the
--     kickoff) and set_delivery_stage (move the run's project
--     to a stage, firing milestones exactly like the hub UI).
--
--   • automation_runs.project_id — runs can finally carry the
--     project they concern, so steps and the Runs tab can
--     deep-link to it.
--
-- The trigger/kind lists are TEXT + CHECK constraints (0032),
-- so extending them is a drop-and-recreate of the constraint
-- with the full list — same as 0048 and 0051 did.
--
-- Safe to re-run: every statement is idempotent.
-- ============================================================

alter table public.automations drop constraint if exists automations_trigger_check;
alter table public.automations add constraint automations_trigger_check check (trigger in (
  'lead_created',
  'form_submitted',
  'stage_changed',
  'tag_added',
  'lead_inactive',
  'date_reached',
  'invoice_unpaid',
  'installment_due',
  'cheque_due',
  'quote_accepted',
  'client_created',
  'webhook',
  'wa_message_received',
  'quote_viewed',
  'payment_received',
  'project_stage_changed',
  'project_delivered',
  'asset_submitted',
  'assets_complete'
));

alter table public.automation_steps drop constraint if exists automation_steps_kind_check;
alter table public.automation_steps add constraint automation_steps_kind_check check (kind in (
  'send_sms',
  'send_email',
  'create_task',
  'add_tag',
  'remove_tag',
  'assign_user',
  'move_stage',
  'update_field',
  'update_score',
  'notify',
  'webhook',
  'ai_agent',
  'enroll_sms_workflow',
  'wait',
  'send_whatsapp',
  'convert_quote_to_invoice',
  'create_project',
  'start_wa_onboarding',
  'set_delivery_stage'
));

alter table public.automation_runs
  add column if not exists project_id uuid
    references public.projects (id) on delete set null;

create index if not exists automation_runs_project_idx
  on public.automation_runs (project_id);
