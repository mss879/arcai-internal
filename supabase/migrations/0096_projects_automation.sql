-- ============================================================
-- 0096_projects_automation.sql
--
-- PROJECTS ROADMAP — theme 6 (AUTO).
--
-- 0085 taught the automation engine that projects exist: four
-- triggers, three steps. It could watch a stage move and send a
-- message. It could not watch a deadline, a cost, a sign-off or
-- a bill, and it could not raise an invoice, staff a job or ask
-- for an asset. This closes both halves.
--
--   • AUTO-1 — ten new triggers:
--       project_created        a project record is born
--       project_due_soon       due_date is X days out       (timer)
--       project_overdue        due_date has passed          (timer)
--       balance_overdue        delivered, still owed money  (timer)
--       expense_added          a cost lands on a project
--       expenses_over_budget   recorded costs pass the cap
--       milestone_completed    a milestone is ticked off
--       client_approved        the client signs off on the portal
--       project_completed      status becomes Completed
--       project_stalled        the idle-project alert, promoted
--                              from a notification into a trigger
--
--   • AUTO-2 — ten new steps:
--       create_project_invoice  raise the real balance invoice
--       send_portal_link        text the portal link + passcode
--       seed_task_template      apply a plan template
--       assign_member           put someone on the job
--       request_asset           add a checklist item to collect
--       add_expense             record a cost
--       set_project_status      planning/active/on_hold/…
--       create_payment_plan     schedule the instalments
--       schedule_meeting        book the call
--       draft_client_update     AI-write the update, file it
--
--   • AUTO-7 — projects.automation_paused: one switch that stands
--     every automation down for a single project, without pausing
--     it for everyone else. Set on a job that has gone sideways so
--     the chasers stop while it is sorted out.
--
-- The trigger/kind lists are TEXT + CHECK constraints (0032), so
-- extending them is a drop-and-recreate carrying the FULL list —
-- same as 0048, 0051 and 0085 did.
--
-- Additive and idempotent: safe against the currently-live build,
-- and safe to re-run.
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
  -- 0085 — Client Delivery
  'project_stage_changed',
  'project_delivered',
  'asset_submitted',
  'assets_complete',
  -- 0096 — Projects theme 6
  'project_created',
  'project_due_soon',
  'project_overdue',
  'balance_overdue',
  'expense_added',
  'expenses_over_budget',
  'milestone_completed',
  'client_approved',
  'project_completed',
  'project_stalled'
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
  -- 0085 — Client Delivery
  'start_wa_onboarding',
  'set_delivery_stage',
  -- 0096 — Projects theme 6
  'create_project_invoice',
  'send_portal_link',
  'seed_task_template',
  'assign_member',
  'request_asset',
  'add_expense',
  'set_project_status',
  'create_payment_plan',
  'schedule_meeting',
  'draft_client_update'
));

-- AUTO-7 — stand every automation down for one project.
alter table public.projects
  add column if not exists automation_paused boolean not null default false;

comment on column public.projects.automation_paused is
  'AUTO-7: while true no automation trigger enrolls this project and its in-flight runs stand still. Per-project, so pausing a job in trouble does not pause the workflow for everyone else.';

-- The due-soon / overdue scans read a narrow slice of open projects by
-- deadline every tick; without this they are a sequential scan each time.
create index if not exists projects_open_due_idx
  on public.projects (due_date)
  where deleted_at is null and due_date is not null;

-- balance_overdue walks projects that reached "delivered" a while ago.
create index if not exists projects_delivered_at_idx
  on public.projects (delivery_stage_changed_at)
  where deleted_at is null and delivery_stage = 'delivered';
