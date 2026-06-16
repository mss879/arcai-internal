import { getMembers } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import type { LeadWithAssignee, PipelineStage } from "@/lib/types";

import { CrmBoard } from "./crm-board";

export const metadata = { title: "CRM Pipeline" };

export default async function CrmPage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string }>;
}) {
  const { p } = await searchParams;
  const supabase = await createClient();

  const [pipelinesRes, members, clientsRes] = await Promise.all([
    supabase
      .from("pipelines")
      .select("*")
      .order("position", { ascending: true })
      .order("created_at", { ascending: true }),
    getMembers(),
    supabase.from("clients").select("id, name, company").order("name"),
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
    />
  );
}
