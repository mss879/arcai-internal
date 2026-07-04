-- ============================================================
-- 0029_sms_promotions.sql
-- Promotions tab: bulk offer messages sent to many clients at
-- once are logged with kind = 'promotion'. Widen the check
-- constraint on sms_messages.kind (added in 0028) to allow it.
-- ============================================================

alter table public.sms_messages
  drop constraint if exists sms_messages_kind_check;

alter table public.sms_messages
  add constraint sms_messages_kind_check
  check (kind in ('custom', 'payment_reminder', 'automation', 'promotion'));
