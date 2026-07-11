import { createClient } from "@/lib/supabase/server";
import { isPlacesConfigured } from "@/lib/ai/places";
import { isProspectingConfigured } from "@/lib/prospecting";
import { isSmsConfigured } from "@/lib/sms";
import type {
  ProspectCandidate,
  ProspectScan,
  ProspectScanSchedule,
} from "@/lib/types";

import { ProspectingView, type PipelineOption } from "./prospecting-view";

export const metadata = { title: "Find Leads" };

/** Scan launches kick off Places/Firecrawl work in `after()` — give it room. */
export const maxDuration = 60;

export default async function ProspectingPage({
  searchParams,
}: {
  searchParams: Promise<{ scan?: string }>;
}) {
  const [supabase, { scan: scanParam }] = await Promise.all([
    createClient(),
    searchParams,
  ]);

  const { data: scansData } = await supabase
    .from("prospect_scans")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(20);
  const scans = (scansData ?? []) as ProspectScan[];

  // Candidates for the selected scan (defaults to the newest one).
  const selectedId =
    scanParam && scans.some((s) => s.id === scanParam)
      ? scanParam
      : (scans[0]?.id ?? null);
  let candidates: ProspectCandidate[] = [];
  if (selectedId) {
    const { data } = await supabase
      .from("prospect_candidates")
      .select("*")
      .eq("scan_id", selectedId)
      .order("created_at", { ascending: true })
      .limit(200);
    candidates = (data ?? []) as ProspectCandidate[];
  }

  // Destination pipelines for the launcher.
  const [{ data: pipelines }, { data: stages }, { data: schedules }] =
    await Promise.all([
      supabase.from("pipelines").select("id, name, position").order("position"),
      supabase
        .from("pipeline_stages")
        .select("id, pipeline_id, name, position")
        .order("position"),
      supabase
        .from("prospect_scan_schedules")
        .select("*")
        .order("created_at", { ascending: false }),
    ]);
  const pipelineOptions: PipelineOption[] = (pipelines ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    stages: (stages ?? [])
      .filter((s) => s.pipeline_id === p.id)
      .map((s) => ({ id: s.id, name: s.name })),
  }));

  return (
    <ProspectingView
      scans={scans}
      selectedId={selectedId}
      candidates={candidates}
      pipelines={pipelineOptions}
      schedules={(schedules ?? []) as ProspectScanSchedule[]}
      configured={isProspectingConfigured()}
      placesConfigured={isPlacesConfigured()}
      smsConfigured={isSmsConfigured()}
      emailConfigured={Boolean(process.env.RESEND_API_KEY?.trim())}
    />
  );
}
