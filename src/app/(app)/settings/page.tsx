import { requireAdmin } from "@/lib/auth";
import { isSocialCryptoConfigured } from "@/lib/social/crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { SettingsView, type SettingsData } from "./settings-view";

export const metadata = { title: "Settings" };

/**
 * One front door to every setting (T5.1).
 *
 * The workspace grew a settings surface per module — CRM fields, delivery
 * defaults, the WhatsApp agent, pricing, email templates, the studio, API
 * keys — and no page that listed them. This one links to each, and holds
 * the handful of switches that never had a home: where an inbound lead
 * lands, cold outreach, website chat → lead, the connected social accounts,
 * and the document number series.
 */
export default async function SettingsPage() {
  await requireAdmin();
  const supabase = await createClient();
  // document_counters has no RLS policies (only next_document_number() reads
  // it), and app_settings / social_accounts are admin-read: the service-role
  // client behind requireAdmin() is the honest way in.
  const admin = createAdminClient();

  const [
    settingsRes,
    pipelinesRes,
    stagesRes,
    socialRes,
    countersRes,
    waRes,
    profilesRes,
    templatesRes,
    apiKeysRes,
    webhooksRes,
    clientsRes,
  ] = await Promise.all([
    admin
      .from("app_settings")
      .select("key, value, updated_at")
      .in("key", ["lead_form", "outreach", "web_chat_auto_lead"])
      .then((r) => r, () => ({ data: null })),
    supabase.from("pipelines").select("id, name").order("position"),
    supabase.from("pipeline_stages").select("id, name, pipeline_id").order("position"),
    admin
      .from("social_accounts")
      .select("id, platform, name, external_id, page_id, client_id, active, token_expires_at, created_at")
      .order("created_at", { ascending: false })
      .then((r) => r, () => ({ data: null })),
    admin
      .from("document_counters")
      .select("kind, prefix, width, suffix, last, yearly, updated_at")
      .order("kind")
      .then((r) => r, () => ({ data: null })),
    supabase
      .from("wa_agent_config")
      .select("handoff_user_id")
      .limit(1)
      .maybeSingle()
      .then((r) => r, () => ({ data: null })),
    supabase.from("profiles").select("id, full_name, role").order("full_name"),
    supabase
      .from("email_templates")
      .select("id", { count: "exact", head: true })
      .then((r) => r, () => ({ count: 0 })),
    supabase
      .from("api_keys")
      .select("id", { count: "exact", head: true })
      .then((r) => r, () => ({ count: 0 })),
    supabase
      .from("webhook_endpoints")
      .select("id", { count: "exact", head: true })
      .then((r) => r, () => ({ count: 0 })),
    supabase.from("clients").select("id, name").order("name").limit(500),
  ]);

  const settings = new Map<string, Record<string, unknown>>();
  for (const row of settingsRes.data ?? []) settings.set(row.key, row.value ?? {});
  const leadForm = settings.get("lead_form") ?? {};
  const outreach = settings.get("outreach") ?? {};
  const chat = settings.get("web_chat_auto_lead") ?? {};

  const handoffId = waRes.data?.handoff_user_id ?? null;
  const profiles = profilesRes.data ?? [];

  const data: SettingsData = {
    leadForm: {
      pipelineId: typeof leadForm.pipeline_id === "string" ? leadForm.pipeline_id : "",
      stageId: typeof leadForm.stage_id === "string" ? leadForm.stage_id : "",
    },
    outreach: {
      enabled: outreach.enabled !== false,
      fromEmail: typeof outreach.from_email === "string" ? outreach.from_email : "",
    },
    chatAutoLead: chat.enabled === true,
    pipelines: (pipelinesRes.data ?? []).map((p) => ({ id: p.id, name: p.name })),
    stages: (stagesRes.data ?? []).map((s) => ({ id: s.id, name: s.name, pipelineId: s.pipeline_id })),
    social: {
      configured: isSocialCryptoConfigured(),
      accounts: (socialRes.data ?? []).map((a) => ({
        id: a.id,
        platform: a.platform,
        name: a.name,
        externalId: a.external_id,
        pageId: a.page_id,
        clientId: a.client_id,
        active: a.active,
        tokenExpiresAt: a.token_expires_at,
      })),
    },
    counters: (countersRes.data ?? []).map((c) => ({
      kind: c.kind,
      prefix: c.prefix,
      width: c.width,
      suffix: c.suffix,
      last: c.last,
      yearly: c.yearly,
      updatedAt: c.updated_at,
    })),
    handoff: {
      userId: handoffId,
      name: profiles.find((p) => p.id === handoffId)?.full_name ?? null,
    },
    counts: {
      emailTemplates: templatesRes.count ?? 0,
      apiKeys: apiKeysRes.count ?? 0,
      webhooks: webhooksRes.count ?? 0,
      members: profiles.length,
    },
    clients: (clientsRes.data ?? []).map((c) => ({ id: c.id, name: c.name })),
  };

  return <SettingsView data={data} />;
}
