import { gateRead, readJson, serialiseConversation } from "@/lib/ai-projects/read-api";

/**
 * GET /api/ai/v1/conversations/:id  (0127)
 *
 * One transcript. Tool calls appear as a name and nothing else: the
 * arguments and the client's own response are operational detail, and the
 * client already has both sides of that exchange in their own logs.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await gateRead(request);
  if (!gate.ok) return gate.response;
  const { id } = await params;

  const { data: conversation } = await gate.db
    .from("ai_conversations")
    .select(
      "id, started_at, last_message_at, user_messages, message_count, page_url, page_title, country, lead_id, handoff_requested_at, handoff_summary",
    )
    .eq("id", id)
    .eq("project_id", gate.project.id)
    .eq("is_preview", false)
    .maybeSingle();
  if (!conversation) return readJson({ error: "No such conversation." }, 404);

  const { data: messages } = await gate.db
    .from("ai_messages")
    .select("id, role, content, tool_name, created_at")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true })
    .limit(200);

  return readJson({
    conversation: serialiseConversation(conversation),
    messages: (messages ?? []).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.role === "tool" ? "" : m.content,
      tool: m.tool_name,
      at: m.created_at,
    })),
  });
}
