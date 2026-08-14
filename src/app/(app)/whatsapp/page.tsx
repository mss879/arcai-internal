import { isOpenAIConfigured } from "@/lib/ai/openai";
import { createClient } from "@/lib/supabase/server";
import { previewColdQueue } from "@/lib/wa-cold-outreach";
import type {
  Automation,
  Pipeline,
  PipelineStage,
  WaAgentConfig,
  WaAgentLog,
  WaCampaign,
  WaColdOutreach,
  WaContact,
  WaKeywordRule,
  WaLesson,
  WaMessage,
  WaPromise,
} from "@/lib/types";
import { isWhatsAppConfigured } from "@/lib/whatsapp";

import { WhatsappView } from "./whatsapp-view";

export const metadata = { title: "WhatsApp" };

/** What the live campaign has actually produced — the numbers that say
 * whether the ad spend is working, not just how many people messaged. */
export type CampaignStats = {
  leads: number;
  /** First reply as the customer experienced it, in seconds. */
  medianFirstReply: number | null;
  p90FirstReply: number | null;
  inCrm: number;
  quoted: number;
  won: number;
  revenue: number;
  closeRate: number | null;
};

async function buildCampaignStats(
  supabase: Awaited<ReturnType<typeof createClient>>,
  contacts: { lead_id: string | null; first_reply_seconds: number | null }[],
): Promise<CampaignStats> {
  const waits = contacts
    .map((c) => c.first_reply_seconds)
    .filter((s): s is number => s != null)
    .sort((a, b) => a - b);
  const at = (q: number) =>
    waits.length ? waits[Math.min(waits.length - 1, Math.floor(waits.length * q))] : null;

  const leadIds = contacts
    .map((c) => c.lead_id)
    .filter((id): id is string => Boolean(id));

  const [leadsRes, quotesRes] = await Promise.all([
    leadIds.length
      ? supabase.from("leads").select("id, status, value").in("id", leadIds)
      : Promise.resolve({ data: [] as { id: string; status: string; value: number | null }[] }),
    leadIds.length
      ? supabase.from("quotes").select("lead_id").in("lead_id", leadIds)
      : Promise.resolve({ data: [] as { lead_id: string | null }[] }),
  ]);

  const leads = leadsRes.data ?? [];
  const won = leads.filter((l) => l.status === "won");
  // A lead may have several quotes — count the leads that got one.
  const quoted = new Set((quotesRes.data ?? []).map((q) => q.lead_id)).size;

  return {
    leads: contacts.length,
    medianFirstReply: at(0.5),
    p90FirstReply: at(0.9),
    inCrm: leadIds.length,
    quoted,
    won: won.length,
    revenue: won.reduce((sum, l) => sum + Number(l.value ?? 0), 0),
    closeRate: contacts.length
      ? Math.round((won.length / contacts.length) * 100)
      : null,
  };
}

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
    lessonsRes,
    promisesRes,
    campaignsRes,
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
    // The approve-first lesson queue: pending proposals + recent decisions.
    // Errors (migration 0073 not yet applied) degrade to an empty list.
    supabase
      .from("wa_lessons")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(60),
    supabase
      .from("wa_promises")
      .select("*")
      .eq("status", "pending")
      .order("due_at")
      .limit(200),
    supabase
      .from("wa_campaigns")
      .select("*")
      .order("created_at", { ascending: false }),
  ]);

  // Per-campaign funnel. Contacts are stamped with whichever campaign was
  // live when they first wrote, so everything hangs off that one column:
  // contact → lead → quote → won.
  const { data: campaignContacts } = await supabase
    .from("wa_contacts")
    .select("campaign_id, lead_id, first_reply_seconds")
    .not("campaign_id", "is", null)
    .limit(5000);
  const campaignCounts: Record<string, number> = {};
  for (const row of campaignContacts ?? []) {
    if (!row.campaign_id) continue;
    campaignCounts[row.campaign_id] = (campaignCounts[row.campaign_id] ?? 0) + 1;
  }

  // The live campaign gets the full funnel; the rest only need their count.
  const liveCampaign =
    (campaignsRes.data ?? []).find((c) => c.status === "active") ?? null;
  const campaignStats = liveCampaign
    ? await buildCampaignStats(
        supabase,
        (campaignContacts ?? []).filter((c) => c.campaign_id === liveCampaign.id),
      )
    : null;

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

  // Who the picker will take next — the REAL eligibility scan, previewed.
  const coldUpcoming = await previewColdQueue(supabase, 5);

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
      lessons={(lessonsRes.data ?? []) as WaLesson[]}
      promises={(promisesRes.data ?? []) as WaPromise[]}
      coldRows={((coldRows ?? []) as WaColdOutreach[]).map((r) => ({
        ...r,
        lead_label: coldLeadById.get(r.lead_id) ?? "Deleted lead",
      }))}
      coldStats={coldStats}
      coldUpcoming={coldUpcoming}
      campaigns={(campaignsRes.data ?? []) as WaCampaign[]}
      campaignCounts={campaignCounts}
      campaignStats={campaignStats}
      waReady={isWhatsAppConfigured()}
      aiReady={isOpenAIConfigured()}
      appBaseUrl={process.env.NEXT_PUBLIC_APP_URL ?? ""}
    />
  );
}
