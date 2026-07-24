import { createClient } from "@/lib/supabase/server";
import type { Pipeline, PipelineStage, WebhookEndpoint } from "@/lib/types";

import { WebhooksView } from "./webhooks-view";

export const metadata = { title: "CRM Webhooks" };

export default async function CrmWebhooksPage() {
  const supabase = await createClient();
  const [hooksRes, pipelinesRes, stagesRes] = await Promise.all([
    supabase
      .from("webhook_endpoints")
      .select("*")
      .order("created_at", { ascending: false }),
    supabase.from("pipelines").select("*").order("position"),
    supabase.from("pipeline_stages").select("*").order("position"),
  ]);

  // This tab is about capturing website leads, so only the "create a lead"
  // webhooks belong here — automation-firing ones live on the Automation page.
  const webhooks = ((hooksRes.data ?? []) as WebhookEndpoint[]).filter(
    (w) => w.action === "create_lead",
  );

  return (
    <WebhooksView
      webhooks={webhooks}
      pipelines={(pipelinesRes.data ?? []) as Pipeline[]}
      stages={(stagesRes.data ?? []) as PipelineStage[]}
    />
  );
}
