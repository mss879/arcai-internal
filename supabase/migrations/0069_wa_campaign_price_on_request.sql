-- ============================================================
-- 0069_wa_campaign_price_on_request.sql
-- Stop the campaign agent volunteering the price.
--
-- 0068 seeded the live campaign's brief with a "PRICING MODEL
-- (lead with this framing — it's the hook)" paragraph, and the
-- agent did exactly that: its opening pitch ended with the
-- one-time setup fee and the Rs 150,000 starting figure before
-- the customer had asked anything about cost.
--
-- The prompt side is fixed in code (wa-agent.ts): price is now
-- on-request only, answered instantly and in full the moment
-- they DO ask. This migration fixes the copy already sitting in
-- the database, which the prompt reads verbatim.
--
-- Deliberately surgical: it rewrites ONLY that one paragraph via
-- replace(), so any edits the team has made to the rest of the
-- brief in the Campaign tab survive untouched. A campaign whose
-- text no longer contains the paragraph is left completely alone.
-- ============================================================

do $$
declare
  old_para text := $old$PRICING MODEL (lead with this framing — it's the hook): a ONE-TIME setup fee and NO monthly fee, ever. After setup the only running cost is their own API usage, paid directly by them (small, scales with their volume). They OWN the system — it's not a subscription they rent forever.$old$;
  new_para text := $new$COMMERCIAL MODEL — do NOT raise any of this unprompted. It exists so you can answer well WHEN THEY ASK about cost, never as part of your opening pitch: a ONE-TIME setup fee and NO monthly fee, ever. After setup the only running cost is their own API usage, paid directly by them (small, scales with their volume). They OWN the system — it's not a subscription they rent forever.$new$;
  price_suffix text := $sfx$ NEVER bring the price up first — no starting figure, no "setup fee" framing, no "just so you know" in the opening message. It comes out only when the customer asks about cost or names a budget.$sfx$;
begin
  -- The brief: neutralise the "lead with the price" instruction.
  update public.wa_campaigns
    set details = replace(details, old_para, new_para)
    where details like '%PRICING MODEL (lead with this framing%';

  -- The pricing line: make on-request explicit, once.
  update public.wa_campaigns
    set pricing_note = btrim(pricing_note) || price_suffix
    where btrim(coalesce(pricing_note, '')) <> ''
      and pricing_note not like '%NEVER bring the price up first%';
end $$;
