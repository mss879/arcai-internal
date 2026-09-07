import { colomboDay } from "@/lib/ai-projects/time-core";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

import { ModelsView } from "./models-view";

export const metadata = { title: "AI model prices" };

/**
 * The price catalog (0126): every OpenAI model the agents may use and what
 * it costs, with effective dates. Every usage row is priced from here at the
 * moment it is written, so this page is the one place a price change is made.
 */
export default async function ModelsPage() {
  await requireAdmin();
  const supabase = await createClient();

  const [pricesRes, usageRes] = await Promise.all([
    supabase.from("ai_model_prices").select("*").order("model").order("effective_from", { ascending: false }),
    // Which models are in use, so a retire/delete can warn.
    supabase.from("ai_projects").select("model").neq("status", "archived"),
  ]);

  const inUse = new Map<string, number>();
  for (const p of usageRes.data ?? []) inUse.set(p.model, (inUse.get(p.model) ?? 0) + 1);

  return <ModelsView rows={pricesRes.data ?? []} inUse={Object.fromEntries(inUse)} today={colomboDay()} />;
}
