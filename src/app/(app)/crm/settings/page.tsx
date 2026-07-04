import { createClient } from "@/lib/supabase/server";
import type { CrmField, CrmSegment, Pipeline } from "@/lib/types";

import { CrmSettings } from "./crm-settings";

export const metadata = { title: "CRM Settings" };

export default async function CrmSettingsPage() {
  const supabase = await createClient();
  const [fieldsRes, pipelinesRes, segmentsRes] = await Promise.all([
    supabase.from("crm_fields").select("*").order("position"),
    supabase.from("pipelines").select("*").order("position"),
    supabase.from("crm_segments").select("*").order("created_at"),
  ]);

  return (
    <CrmSettings
      fields={(fieldsRes.data ?? []) as CrmField[]}
      pipelines={(pipelinesRes.data ?? []) as Pipeline[]}
      segments={(segmentsRes.data ?? []) as CrmSegment[]}
    />
  );
}
