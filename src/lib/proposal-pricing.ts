import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import {
  applyOverrides,
  type PricingGroup,
  type PricingOverrides,
} from "@/lib/pricing-catalog";
import type { MaintenanceKey, ProposalSelection } from "@/lib/proposal";

/**
 * The bridge between the two price catalogs.
 *
 * `@/lib/pricing-catalog` is what the team edits on the /pricing page (amounts
 * stored as an override map in `pricing_config`). `@/lib/proposal` holds its
 * own constants, because a proposal must re-price identically for the rest of
 * time — `buildPricing()` re-runs every time an old proposal is rendered.
 *
 * Historically those two never met, so editing a price on /pricing did nothing
 * to proposals. This module resolves a selection against the LIVE /pricing
 * amounts so a new proposal quotes what the team actually charges today; the
 * caller then freezes the result into `selection.prices`, which is what keeps
 * already-sent proposals printing the numbers their client agreed to.
 *
 * A selection with no matching key — the legacy tiers (starter…scale, shopify,
 * custom) that only survive inside old stored proposals — resolves to nothing
 * and keeps its original constant.
 *
 * Safe to import from both client and server: the pure mapping takes a plain
 * key -> amount map, and only the helpers that read `pricing_config` need a
 * Supabase client passed in.
 */

type DB = SupabaseClient<Database>;

const MAINTENANCE_KEYS: Record<Exclude<MaintenanceKey, "none">, string> = {
  m3: "maint.3mo",
  m6: "maint.6mo",
  m12: "maint.12mo",
};

const MONTHLY_SEO_KEY = "seo.monthly";

/** The /pricing key for a selection's MAIN package line, or null for legacy. */
function baseKey(sel: ProposalSelection): string | null {
  if (sel.type === "business") {
    switch (sel.tier) {
      case "smart_site":
        return "web.smart_site.onetime";
      case "smart_business":
        return "web.smart_business.onetime";
      case "smart_system":
        return "web.smart_system.onetime";
      default:
        return null;
    }
  }
  if (sel.type === "agent") {
    switch (sel.agentPlatform ?? "whatsapp") {
      case "whatsapp":
        return "ai.whatsapp_crm.setup";
      case "instagram":
        return "ai.instagram_crm.setup";
      case "smart_system_budget":
        return "system.budget.onetime";
      default:
        return null;
    }
  }
  switch (sel.platform) {
    case "store":
      return "ecom.store.setup";
    case "smart":
      return "ecom.smart.total";
    default:
      return null;
  }
}

async function loadOverrides(supabase: DB): Promise<PricingOverrides> {
  const { data } = await supabase
    .from("pricing_config")
    .select("overrides")
    .eq("id", 1)
    .maybeSingle();
  return (data?.overrides ?? {}) as PricingOverrides;
}

/** The whole /pricing page as the team has it today — groups, packages,
 * features and edited amounts. Handed to the assistant so it can quote and
 * explain packages without ever inventing a number. */
export async function pricingSnapshot(supabase: DB): Promise<PricingGroup[]> {
  return applyOverrides(await loadOverrides(supabase));
}

/** Every price field flattened to key -> amount. */
export function flattenPricing(groups: PricingGroup[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of groups) {
    for (const p of g.packages) {
      for (const f of p.prices) out[f.key] = f.amount;
    }
  }
  return out;
}

/** The live /pricing amounts as a flat key -> amount map. */
export async function pricingAmounts(supabase: DB): Promise<Record<string, number>> {
  return flattenPricing(await pricingSnapshot(supabase));
}

/**
 * Resolve a selection against /pricing amounts. Pure — hand it the map from
 * `pricingAmounts()` (server) or one passed down to the browser. The result is
 * meant to be stored on the proposal as `selection.prices`: a permanent
 * snapshot, not a live link.
 */
export function selectionPrices(
  amounts: Record<string, number>,
  sel: ProposalSelection,
): NonNullable<ProposalSelection["prices"]> {
  const prices: NonNullable<ProposalSelection["prices"]> = {};

  const bk = baseKey(sel);
  if (bk && typeof amounts[bk] === "number") prices.base = amounts[bk];

  if (sel.maintenance !== "none") {
    const mk = MAINTENANCE_KEYS[sel.maintenance];
    if (mk && typeof amounts[mk] === "number") prices.maintenance = amounts[mk];
  }

  if (sel.monthlySeo && typeof amounts[MONTHLY_SEO_KEY] === "number") {
    prices.monthlySeo = amounts[MONTHLY_SEO_KEY];
  }

  return prices;
}

/** `selectionPrices` with the amounts read straight from `pricing_config`. */
export async function resolveSelectionPrices(
  supabase: DB,
  sel: ProposalSelection,
): Promise<NonNullable<ProposalSelection["prices"]>> {
  return selectionPrices(await pricingAmounts(supabase), sel);
}
