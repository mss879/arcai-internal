import { isOpenAIConfigured } from "@/lib/ai/openai";
import { createClient } from "@/lib/supabase/server";
import type {
  Automation,
  Pipeline,
  PipelineStage,
  WaAgentConfig,
  WaAgentLog,
  WaCoaching,
  WaContact,
  WaKeywordRule,
  WaMessage,
  WaPromise,
} from "@/lib/types";
import { isWhatsAppConfigured } from "@/lib/whatsapp";

import { WhatsappView } from "./whatsapp-view";

export const metadata = { title: "WhatsApp" };

export default async function WhatsappPage() {
  const supabase = await createClient();

  const [
    contactsRes,
    messagesRes,
    configRes,
    rulesRes,
    logsRes,
    pipelinesRes,
    stagesRes,
    automationsRes,
    coachingRes,
    promisesRes,
  ] = await Promise.all([
    supabase
      .from("wa_contacts")
      .select("*")
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(200),
    supabase
      .from("wa_messages")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(600),
    supabase.from("wa_agent_config").select("*").eq("id", 1).maybeSingle(),
    supabase
      .from("wa_keyword_rules")
      .select("*")
      .order("position")
      .order("created_at"),
    supabase
      .from("wa_agent_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("pipelines").select("*").order("position").order("created_at"),
    supabase.from("pipeline_stages").select("*").order("position"),
    supabase.from("automations").select("*").order("created_at", { ascending: false }),
    supabase
      .from("wa_coaching")
      .select("*")
      .order("week_start", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("wa_promises")
      .select("*")
      .eq("status", "pending")
      .order("due_at")
      .limit(200),
  ]);

  return (
    <WhatsappView
      contacts={(contactsRes.data ?? []) as WaContact[]}
      messages={((messagesRes.data ?? []) as WaMessage[]).reverse()}
      config={(configRes.data as WaAgentConfig | null) ?? null}
      rules={(rulesRes.data ?? []) as WaKeywordRule[]}
      logs={(logsRes.data ?? []) as WaAgentLog[]}
      pipelines={(pipelinesRes.data ?? []) as Pipeline[]}
      stages={(stagesRes.data ?? []) as PipelineStage[]}
      automations={(automationsRes.data ?? []) as Automation[]}
      coaching={(coachingRes.data as WaCoaching | null) ?? null}
      promises={(promisesRes.data ?? []) as WaPromise[]}
      waReady={isWhatsAppConfigured()}
      aiReady={isOpenAIConfigured()}
      appBaseUrl={process.env.NEXT_PUBLIC_APP_URL ?? ""}
    />
  );
}
