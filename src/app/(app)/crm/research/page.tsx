import { createClient } from "@/lib/supabase/server";
import { isResearchConfigured } from "@/lib/ai/lead-research";

import { ResearchView, type ResearchRow } from "./research-view";

export const metadata = { title: "Prospect Research" };

export default async function ResearchPage() {
  const supabase = await createClient();

  // The FK join is resolved by PostgREST from the real DB constraint; the
  // hand-authored types model no relationships, so we cast (as the lead
  // detail page does with its `assignee` join).
  const { data } = await supabase
    .from("lead_research")
    .select("*, lead:leads(id, title, company)")
    .order("updated_at", { ascending: false })
    .limit(200);

  const rows = (data ?? []) as unknown as ResearchRow[];

  return <ResearchView rows={rows} configured={isResearchConfigured()} />;
}
