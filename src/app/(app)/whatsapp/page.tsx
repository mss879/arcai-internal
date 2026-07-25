import { isOpenAIConfigured } from "@/lib/ai/openai";
import { createClient } from "@/lib/supabase/server";
import type {
  Automation,
  Pipeline,
  PipelineStage,
  WaAgentConfig,
  WaAgentLog,
  WaCoaching,
  WaColdOutreach,
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

  // The cold-outreach card's "recent picks" list (last 48h of activity).
  const coldSinceDate = new Date();
  coldSinceDate.setHours(coldSinceDate.getHours() - 48);
  const { data: coldRows } = await supabase
    .from("wa_cold_outreach")
    .select("*")
    .gte("updated_at", coldSinceDate.toISOString())
    .order("updated_at", { ascending: false })
    .limit(30);

  // 30-day performance tiles for the same card.
  const statsSinceDate = new Date();
  statsSinceDate.setDate(statsSinceDate.getDate() - 30);
  const statsSince = statsSinceDate.toISOString();
  const weekAgoDate = new Date();
  weekAgoDate.setDate(weekAgoDate.getDate() - 7);
  const weekAgo = weekAgoDate.toISOString();
  const { data: coldStatRows } = await supabase
    .from("wa_cold_outreach")
    .select("status, sent_at, followup_sent_at")
    .or(`sent_at.gte.${statsSince},followup_sent_at.gte.${statsSince}`)
    .limit(1000);
  const attempts = (coldStatRows ?? []).filter(
    (r) =>
      r.sent_at && ["sent", "delivered", "replied", "failed"].includes(r.status),
  );
  const sent30 = attempts.length;
  const replied30 = (coldStatRows ?? []).filter((r) => r.status === "replied").length;
  const coldStats = {
    sent7: attempts.filter((r) => (r.sent_at as string) >= weekAgo).length,
    sent30,
    delivered30: (coldStatRows ?? []).filter((r) =>
      ["delivered", "replied"].includes(r.status),
    ).length,
    replied30,
    replyRate: sent30 > 0 ? Math.round((replied30 / sent30) * 100) : null,
    noWhatsApp30: (coldStatRows ?? []).filter((r) => r.status === "no_whatsapp")
      .length,
    failed30: (coldStatRows ?? []).filter((r) => r.status === "failed").length,
    nudged30: (coldStatRows ?? []).filter((r) => r.followup_sent_at).length,
  };
  const coldLeadIds = (coldRows ?? []).map((r) => r.lead_id);
  const { data: coldLeads } = coldLeadIds.length
    ? await supabase
        .from("leads")
        .select("id, title, company")
        .in("id", coldLeadIds)
    : { data: [] };
  const coldLeadById = new Map(
    (coldLeads ?? []).map((l) => [l.id, l.company?.trim() || l.title]),
  );

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
      coldRows={((coldRows ?? []) as WaColdOutreach[]).map((r) => ({
        ...r,
        lead_label: coldLeadById.get(r.lead_id) ?? "Deleted lead",
      }))}
      coldStats={coldStats}
      waReady={isWhatsAppConfigured()}
      aiReady={isOpenAIConfigured()}
      appBaseUrl={process.env.NEXT_PUBLIC_APP_URL ?? ""}
    />
  );
}
