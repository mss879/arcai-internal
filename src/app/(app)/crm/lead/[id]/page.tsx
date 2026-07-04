import { notFound } from "next/navigation";

import { getMembers } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import type {
  CrmField,
  CrmTask,
  LeadActivity,
  LeadWithAssignee,
  Pipeline,
  PipelineStage,
  Quote,
} from "@/lib/types";

import { LeadDetail } from "./lead-detail";

export const metadata = { title: "Lead" };

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

  const [activitiesRes, tasksRes, quotesRes, fieldsRes, stagesRes, pipelineRes, members] =
    await Promise.all([
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
        .order("created_at", { ascending: false }),
      supabase
        .from("quotes")
        .select("*")
        .eq("lead_id", id)
        .order("created_at", { ascending: false }),
      supabase.from("crm_fields").select("*").order("position"),
      supabase
        .from("pipeline_stages")
        .select("*")
        .eq("pipeline_id", lead.pipeline_id)
        .order("position"),
      supabase.from("pipelines").select("*").eq("id", lead.pipeline_id).single(),
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
      members={members}
    />
  );
}
