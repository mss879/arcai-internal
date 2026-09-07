import { gateRead, readJson } from "@/lib/ai-projects/read-api";
import { colomboDay, daysAgo } from "@/lib/ai-projects/time-core";

/**
 * GET /api/ai/v1/summary?days=30  (0127)
 *
 * The header numbers for the client's own dashboard, in one call, from the
 * daily rollups. Deliberately no cost and no tokens: what the agency pays
 * OpenAI is not part of what the client is shown.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await gateRead(request);
  if (!gate.ok) return gate.response;

  const url = new URL(request.url);
  const raw = Number(url.searchParams.get("days"));
  const days = [7, 30, 90].includes(raw) ? raw : 30;
  const today = colomboDay();
  const from = daysAgo(today, days - 1);

  const { data } = await gate.db
    .from("ai_project_daily")
    .select("day, conversations, user_messages, leads, handoffs")
    .eq("project_id", gate.project.id)
    .gte("day", from)
    .order("day");

  const rows = data ?? [];
  const total = rows.reduce(
    (acc, r) => ({
      conversations: acc.conversations + r.conversations,
      messages: acc.messages + r.user_messages,
      leads: acc.leads + r.leads,
      handoffs: acc.handoffs + r.handoffs,
    }),
    { conversations: 0, messages: 0, leads: 0, handoffs: 0 },
  );

  return readJson({
    agent: gate.project.agent_name,
    range: { from, to: today, days },
    totals: total,
    daily: rows.map((r) => ({
      day: r.day,
      conversations: r.conversations,
      messages: r.user_messages,
      leads: r.leads,
      handoffs: r.handoffs,
    })),
  });
}
