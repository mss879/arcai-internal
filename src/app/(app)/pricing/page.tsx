import { createClient } from "@/lib/supabase/server";
import type { PricingOverrides } from "@/lib/pricing-catalog";

import { PricingView } from "./pricing-view";

export const metadata = { title: "Pricing" };

export default async function PricingPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("pricing_config")
    .select("overrides")
    .eq("id", 1)
    .maybeSingle();

  const overrides = (data?.overrides ?? {}) as PricingOverrides;

  return <PricingView initialOverrides={overrides} />;
}
