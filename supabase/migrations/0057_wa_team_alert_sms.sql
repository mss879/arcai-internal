-- ============================================================
-- 0057_wa_team_alert_sms.sql
-- Text the team when the WhatsApp agent needs a human.
--
--   In-app + push notifications can sit unseen for hours. So the two
--   urgent WhatsApp alert paths — handoff_human (customer asked for a
--   person / frustration / anything sensitive) and notify_team — now
--   ALSO fire an SMS to every teammate with a phone on file (plus any
--   numbers in the TEAM_ALERT_PHONE env var). Those texts are logged in
--   sms_messages with kind = 'team_alert'; widen the check to allow it.
-- ============================================================

alter table public.sms_messages
  drop constraint if exists sms_messages_kind_check;

alter table public.sms_messages
  add constraint sms_messages_kind_check
  check (kind in (
    'custom', 'payment_reminder', 'automation', 'promotion',
    'todo_reminder', 'meeting_reminder', 'prospecting', 'team_alert'
  ));
