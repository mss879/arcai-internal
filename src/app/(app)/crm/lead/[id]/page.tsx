import { notFound } from "next/navigation";

import { getMembers } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import type {
  CrmField,
  CrmTask,
  LeadActivity,
  LeadOutreach,
  LeadResearch,
  LeadWithAssignee,
  Pipeline,
  PipelineStage,
  Quote,
} from "@/lib/types";

import { LeadDetail } from "./lead-detail";

export const metadata = { title: "Lead" };

/**
 * The lead's "Grab branding" / "Run website audit" buttons call server actions
 * that do synchronous Firecrawl scrapes (a brand pass can take ~20s on a slow
 * prospect site). Lift the action timeout above the platform's ~10s default so
 * the scan has room to finish; Netlify clamps this to the account's max.
 */
export const maxDuration = 60;

export default async function LeadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: lead } = await supabase
    .from("leads")
    .select(
      "*, assignee:profiles!leads_assigned_to_fkey(id, full_name, username, avatar_url)",
    )
    .eq("id", id)
    .maybeSingle();
  if (!lead) notFound();

  const [
    activitiesRes,
    tasksRes,
    quotesRes,
    fieldsRes,
    stagesRes,
    pipelineRes,
    researchRes,
    outreachRes,
    members,
  ] = await Promise.all([
    supabase
      .from("lead_activities")
      .select("*")
      .eq("lead_id", id)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("crm_tasks")
      .select("*")
      .eq("lead_id", id)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("quotes")
      .select("*")
      .eq("lead_id", id)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("crm_fields").select("*").order("position"),
    supabase
      .from("pipeline_stages")
      .select("*")
      .eq("pipeline_id", lead.pipeline_id)
      .order("position"),
    supabase.from("pipelines").select("*").eq("id", lead.pipeline_id).single(),
    supabase
      .from("lead_research")
      .select("*")
      .eq("lead_id", id)
      .maybeSingle(),
    supabase
      .from("lead_outreach")
      .select("*")
      .eq("lead_id", id)
      .maybeSingle(),
    getMembers(),
  ]);

  return (
    <LeadDetail
      lead={lead as unknown as LeadWithAssignee}
      activities={(activitiesRes.data ?? []) as LeadActivity[]}
      tasks={(tasksRes.data ?? []) as CrmTask[]}
      quotes={(quotesRes.data ?? []) as Quote[]}
      customFields={(fieldsRes.data ?? []) as CrmField[]}
      stages={(stagesRes.data ?? []) as PipelineStage[]}
      pipeline={(pipelineRes.data ?? null) as Pipeline | null}
      research={(researchRes.data ?? null) as LeadResearch | null}
      outreach={(outreachRes.data ?? null) as LeadOutreach | null}
      members={members}
    />
  );
}
