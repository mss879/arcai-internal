import { createClient } from "@/lib/supabase/server";
import type { CrmField, Pipeline, PipelineStage } from "@/lib/types";

import { ImportWizard } from "./import-wizard";

export const metadata = { title: "Import leads" };

export default async function ImportPage() {
  const supabase = await createClient();
  const [pipelinesRes, stagesRes, fieldsRes] = await Promise.all([
    supabase.from("pipelines").select("*").order("position"),
    supabase.from("pipeline_stages").select("*").order("position"),
    supabase.from("crm_fields").select("*").order("position"),
  ]);

  return (
    <ImportWizard
      pipelines={(pipelinesRes.data ?? []) as Pipeline[]}
      stages={(stagesRes.data ?? []) as PipelineStage[]}
      customFields={(fieldsRes.data ?? []) as CrmField[]}
    />
  );
}
