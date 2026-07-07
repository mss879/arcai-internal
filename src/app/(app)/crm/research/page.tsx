import { createClient } from "@/lib/supabase/server";
import { isResearchConfigured } from "@/lib/ai/lead-research";

import { ResearchView, type ResearchRow } from "./research-view";

export const metadata = { title: "Prospect Research" };

/**
 * The report's "Grab branding" / "Run website audit" buttons call server actions
 * that do synchronous Firecrawl scrapes (a brand pass can take ~20s on a slow
 * prospect site). Lift the action timeout above the platform's ~10s default so
 * the scan has room to finish; Netlify clamps this to the account's max.
 */
export const maxDuration = 60;

export default async function ResearchPage({
  searchParams,
}: {
  searchParams: Promise<{ lead?: string }>;
}) {
  // `?lead=<id>` (from a lead's "Open the full research view" link) auto-opens
  // that lead's report.
  const [supabase, { lead: initialLeadId }] = await Promise.all([
    createClient(),
    searchParams,
  ]);

  // The FK join is resolved by PostgREST from the real DB constraint; the
  // hand-authored types model no relationships, so we cast (as the lead
  // detail page does with its `assignee` join).
  const { data } = await supabase
    .from("lead_research")
    .select("*, lead:leads(id, title, company)")
    .order("updated_at", { ascending: false })
    .limit(200);

  const rows = (data ?? []) as unknown as ResearchRow[];

  return (
    <ResearchView
      rows={rows}
      configured={isResearchConfigured()}
      initialLeadId={initialLeadId ?? null}
    />
  );
}
