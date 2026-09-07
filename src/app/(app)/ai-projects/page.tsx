import { colomboPeriod } from "@/lib/ai-projects/time-core";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { AiProjectStatus } from "@/lib/types";

import { AiProjectsView, type AiProjectCard, type ClientOption } from "./ai-projects-view";

export const metadata = { title: "AI Projects" };

type ProjectRow = {
  id: string;
  name: string;
  status: AiProjectStatus;
  website_url: string | null;
  agent_name: string;
  model: string;
  avatar_url: string | null;
  primary_color: string;
  billing_currency: "USD" | "LKR";
  last_crawl_at: string | null;
  created_at: string;
  client: { id: string; name: string; company: string | null } | null;
};

/**
 * The AI Projects list (0126): every client's hosted agent, with this
 * month's spend and conversations beside each so the owner sees at a glance
 * which agents are busy and what they are costing.
 */
export default async function AiProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireAdmin();
  const supabase = await createClient();
  const params = await searchParams;
  const period = colomboPeriod();

  const [projectsRes, dailyRes, clientsRes] = await Promise.all([
    supabase
      .from("ai_projects")
      .select(
        "id, name, status, website_url, agent_name, model, avatar_url, primary_color, billing_currency, last_crawl_at, created_at, client:clients(id, name, company)",
      )
      .order("created_at", { ascending: false })
      .then((r) => r, () => ({ data: null })),
    supabase
      .from("ai_project_daily")
      .select("project_id, cost_usd, conversations, user_messages")
      .gte("day", period)
      .then((r) => r, () => ({ data: null })),
    supabase.from("clients").select("id, name, company").order("name").limit(500),
  ]);

  const month = new Map<string, { cost: number; conversations: number; messages: number }>();
  for (const d of dailyRes.data ?? []) {
    const cur = month.get(d.project_id) ?? { cost: 0, conversations: 0, messages: 0 };
    cur.cost += Number(d.cost_usd) || 0;
    cur.conversations += d.conversations;
    cur.messages += d.user_messages;
    month.set(d.project_id, cur);
  }

  const rows = ((projectsRes.data ?? []) as unknown as ProjectRow[]).map<AiProjectCard>((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    websiteUrl: p.website_url,
    agentName: p.agent_name,
    model: p.model,
    avatarUrl: p.avatar_url,
    primaryColor: p.primary_color,
    currency: p.billing_currency,
    lastCrawlAt: p.last_crawl_at,
    createdAt: p.created_at,
    clientName: p.client?.company || p.client?.name || null,
    monthCostUsd: month.get(p.id)?.cost ?? 0,
    monthConversations: month.get(p.id)?.conversations ?? 0,
    monthMessages: month.get(p.id)?.messages ?? 0,
  }));

  const clients: ClientOption[] = (clientsRes.data ?? []).map((c) => ({
    id: c.id,
    label: c.company ? `${c.name} — ${c.company}` : c.name,
  }));

  const status = params.status ?? "";
  return (
    <AiProjectsView
      projects={rows}
      clients={clients}
      initialStatus={["draft", "active", "paused", "archived"].includes(status) ? status : ""}
      periodLabelText={new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })}
    />
  );
}
