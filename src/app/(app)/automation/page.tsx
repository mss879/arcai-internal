import { getMembers } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { isSmsConfigured } from "@/lib/sms";
import type {
  ApiKey,
  Automation,
  AutomationRun,
  AutomationStep,
  Pipeline,
  PipelineStage,
  SmsWorkflow,
  WebhookEndpoint,
} from "@/lib/types";

import { AutomationView } from "./automation-view";

export const metadata = { title: "Automation" };

export default async function AutomationPage() {
  const supabase = await createClient();

  const [
    automationsRes,
    stepsRes,
    runsRes,
    webhooksRes,
    apiKeysRes,
    smsWorkflowsRes,
    pipelinesRes,
    stagesRes,
    templatesRes,
    members,
  ] = await Promise.all([
    supabase.from("automations").select("*").order("created_at", { ascending: false }),
    supabase.from("automation_steps").select("*").order("position", { ascending: true }),
    supabase
      .from("automation_runs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(150),
    supabase.from("webhook_endpoints").select("*").order("created_at", { ascending: false }),
    supabase.from("api_keys").select("*").order("created_at", { ascending: false }),
    supabase.from("sms_workflows").select("*").order("created_at", { ascending: false }),
    supabase.from("pipelines").select("*").order("position"),
    supabase.from("pipeline_stages").select("*").order("position"),
    // 0096 — the seed_task_template step picks one of these.
    supabase
      .from("project_templates")
      .select("id, name, service_type")
      .eq("is_active", true)
      .order("name"),
    getMembers(),
  ]);

  return (
    <AutomationView
      automations={(automationsRes.data ?? []) as Automation[]}
      steps={(stepsRes.data ?? []) as AutomationStep[]}
      runs={(runsRes.data ?? []) as AutomationRun[]}
      webhooks={(webhooksRes.data ?? []) as WebhookEndpoint[]}
      apiKeys={(apiKeysRes.data ?? []) as ApiKey[]}
      smsWorkflows={(smsWorkflowsRes.data ?? []) as SmsWorkflow[]}
      pipelines={(pipelinesRes.data ?? []) as Pipeline[]}
      stages={(stagesRes.data ?? []) as PipelineStage[]}
      templates={templatesRes.data ?? []}
      members={members}
      smsReady={isSmsConfigured()}
    />
  );
}
