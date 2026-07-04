import { getMembers } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import type {
  Company,
  CrmField,
  CrmSegment,
  CrmTask,
  LeadWithAssignee,
  PipelineStage,
} from "@/lib/types";

import { CrmBoard } from "./crm-board";

export const metadata = { title: "CRM Pipeline" };

export default async function CrmPage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string }>;
}) {
  const { p } = await searchParams;
  const supabase = await createClient();

  const [pipelinesRes, members, clientsRes, fieldsRes, segmentsRes, companiesRes, tasksRes] =
    await Promise.all([
      supabase
        .from("pipelines")
        .select("*")
        .order("position", { ascending: true })
        .order("created_at", { ascending: true }),
      getMembers(),
      supabase.from("clients").select("id, name, company").order("name"),
      supabase.from("crm_fields").select("*").order("position"),
      supabase.from("crm_segments").select("*").order("position").order("created_at"),
      supabase.from("companies").select("*").order("name"),
      supabase
        .from("crm_tasks")
        .select("*")
        .eq("status", "open")
        .order("due_at", { ascending: true })
        .limit(200),
    ]);

  const pipelines = pipelinesRes.data;
  const activeId =
    p && pipelines?.some((x) => x.id === p)
      ? p
      : (pipelines?.[0]?.id ?? null);

  let stages: PipelineStage[] = [];
  let leads: LeadWithAssignee[] = [];

  if (activeId) {
    const [stagesRes, leadsRes] = await Promise.all([
      supabase
        .from("pipeline_stages")
        .select("*")
        .eq("pipeline_id", activeId)
        .order("position", { ascending: true }),
      supabase
        .from("leads")
        .select(
          "*, assignee:profiles!leads_assigned_to_fkey(id, full_name, username, avatar_url)",
        )
        .eq("pipeline_id", activeId)
        .is("deleted_at", null)
        .order("position", { ascending: true }),
    ]);
    stages = stagesRes.data ?? [];
    leads = (leadsRes.data ?? []) as unknown as LeadWithAssignee[];
  }

  return (
    <CrmBoard
      pipelines={pipelines ?? []}
      activePipelineId={activeId}
      stages={stages}
      leads={leads}
      members={members}
      clients={clientsRes.data ?? []}
      customFields={(fieldsRes.data ?? []) as CrmField[]}
      segments={(segmentsRes.data ?? []) as CrmSegment[]}
      companies={(companiesRes.data ?? []) as Company[]}
      openTasks={(tasksRes.data ?? []) as CrmTask[]}
    />
  );
}
