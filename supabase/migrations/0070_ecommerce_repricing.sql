-- ============================================================
-- 0070_ecommerce_repricing.sql
-- New e-commerce pricing (2026-08).
--
-- The lineup changed in code (pricing-catalog.ts + proposal.ts):
--
--   E-Commerce Store          from Rs 150,000 one-time
--   Smart Store System        from Rs 350,000 one-time
--     (= store + customer profiles + workflow automations;
--      adding the layer to an existing ARC store: from Rs 200,000)
--   Automation add-ons        Rs 30,000 per automation, beyond
--                             the Smart Store standard set
--
-- This REPLACES the old lineup (Shopify build Rs 75,000, custom
-- store from Rs 120,000, gateway/delivery add-ons Rs 25,000).
-- Old proposals still render their original numbers — the legacy
-- plans live on in code, they're just never offered again.
--
-- Prices themselves live in code + the /pricing page's override
-- map, so the only database work is hygiene: drop any saved
-- overrides for price keys that no longer exist in the catalog.
-- They'd be silently ignored today, but a future package reusing
-- one of these keys would inherit a years-old number — the exact
-- class of bug ("agent quotes old pricing") this change is fixing.
-- ============================================================

update public.pricing_config
  set overrides = coalesce(overrides, '{}'::jsonb)
    - 'ecom.shopify.setup'
    - 'ecom.shopify.monthly'
    - 'ecom.custom.setup'
    - 'ecom.addon.gateway'
    - 'ecom.addon.delivery'
  where id = 1;
