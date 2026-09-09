import "server-only";

import { cache } from "react";

import {
  DEFAULT_BUSINESS_CONFIG,
  mergeBusinessConfig,
  type BusinessConfig,
} from "@/lib/business-config-core";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Who this deployment is (0129). The reader; the shape and the defaults
 * live in `business-config-core.ts`.
 *
 * Reads through the service-role client for the same reason
 * `capabilitiesEnforced()` does: `app_settings` is admin-only from 0129, and
 * a member rendering an invoice still needs the company's name on it.
 *
 * Never throws and never returns a partial answer. A missing row, an
 * unapplied migration or an unreachable database all resolve to the
 * defaults, which are exactly today's hardcoded values — so the worst case
 * is the behaviour the app already had.
 */
export const businessConfig = cache(async (): Promise<BusinessConfig> => {
  try {
    const { data } = await createAdminClient()
      .from("app_settings")
      .select("value")
      .eq("key", "business")
      .maybeSingle();
    return mergeBusinessConfig(data?.value ?? null);
  } catch {
    return DEFAULT_BUSINESS_CONFIG;
  }
});
