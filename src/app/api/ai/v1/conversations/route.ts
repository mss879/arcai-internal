import {
  gateRead,
  readJson,
  readLimit,
  readSince,
  serialiseConversation,
} from "@/lib/ai-projects/read-api";

/**
 * GET /api/ai/v1/conversations  (0127)
 *
 * Conversation summaries for the client's own dashboard. Preview
 * conversations — the agency rehearsing on the Deploy tab — are excluded:
 * they are not the client's traffic and would flatter the numbers.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await gateRead(request);
  if (!gate.ok) return gate.response;

  const url = new URL(request.url);
  let query = gate.db
    .from("ai_conversations")
    .select(
      "id, started_at, last_message_at, user_messages, message_count, page_url, page_title, country, lead_id, handoff_requested_at, handoff_summary",
    )
    .eq("project_id", gate.project.id)
    .eq("is_preview", false)
    .order("last_message_at", { ascending: false })
    .limit(readLimit(url));

  const since = readSince(url);
  if (since) query = query.gte("last_message_at", since);

  const { data, error } = await query;
  if (error) return readJson({ error: "Could not read conversations." }, 500);
  return readJson({ conversations: (data ?? []).map(serialiseConversation) });
}
