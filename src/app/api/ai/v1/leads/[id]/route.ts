import { gateRead, readJson, serialiseLead } from "@/lib/ai-projects/read-api";
import type { AiLeadStatus } from "@/lib/types";

/**
 * PATCH /api/ai/v1/leads/:id  (0127)
 *
 * The one write the client gets: marking a lead contacted or archived from
 * their own dashboard. Everything else about the agent — its prompt, its
 * knowledge, its tools — stays with the agency.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES: AiLeadStatus[] = ["new", "contacted", "archived"];

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await gateRead(request);
  if (!gate.ok) return gate.response;
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return readJson({ error: "Send a JSON body." }, 400);
  }
  const status = typeof body.status === "string" ? (body.status as AiLeadStatus) : ("" as AiLeadStatus);
  if (!STATUSES.includes(status)) {
    return readJson({ error: `status must be one of: ${STATUSES.join(", ")}.` }, 400);
  }

  // Scoped to the key's own project: a valid key for one client can never
  // touch another's lead, whatever id it sends.
  const { data, error } = await gate.db
    .from("ai_leads")
    .update({ status })
    .eq("id", id)
    .eq("project_id", gate.project.id)
    .select("id, name, email, phone, company, interest, page_url, status, conversation_id, created_at")
    .maybeSingle();
  if (error) return readJson({ error: "Could not update that lead." }, 500);
  if (!data) return readJson({ error: "No such lead." }, 404);
  return readJson({ lead: serialiseLead(data) });
}
