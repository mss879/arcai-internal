-- ============================================================
-- 0077_wa_first_reply_ab.sql
-- Campaign first-reply A/B testing.
--
--   The instant first reply is the highest-leverage message a
--   campaign sends (every single lead gets it, within seconds).
--   A campaign may now carry an optional VARIANT B: when set,
--   new leads are split deterministically between A and B and
--   each contact is stamped with the variant they received, so
--   the Analytics tab can compare reply rates and agent wins
--   (booked calls) per variant. Leave first_reply_b empty and
--   nothing changes.
-- ============================================================

alter table public.wa_campaigns
  add column if not exists first_reply_b text;

alter table public.wa_contacts
  add column if not exists first_reply_variant text
    check (first_reply_variant in ('a', 'b'));
