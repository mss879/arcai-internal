import {
  gateRead,
  readJson,
  readLimit,
  readSince,
  serialiseLead,
} from "@/lib/ai-projects/read-api";
import type { AiLeadStatus } from "@/lib/types";

/**
 * GET /api/ai/v1/leads  (0127)
 *
 * The client's own site, reading its own leads. Bearer key, server-side
 * only — there is no OPTIONS handler and no CORS header anywhere in this
 * tree, so a browser can never call it.
 *
 *   ?since=ISO   only leads captured after this
 *   ?status=new|contacted|archived
 *   ?limit=1..200 (default 50)
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await gateRead(request);
  if (!gate.ok) return gate.response;

  const url = new URL(request.url);
  const raw = url.searchParams.get("status");
  const status = raw && ["new", "contacted", "archived"].includes(raw) ? (raw as AiLeadStatus) : null;
  let query = gate.db
    .from("ai_leads")
    .select("id, name, email, phone, company, interest, page_url, status, conversation_id, created_at")
    .eq("project_id", gate.project.id)
    .order("created_at", { ascending: false })
    .limit(readLimit(url));

  if (status) query = query.eq("status", status);
  const since = readSince(url);
  if (since) query = query.gte("created_at", since);

  const { data, error } = await query;
  if (error) return readJson({ error: "Could not read leads." }, 500);
  return readJson({ leads: (data ?? []).map(serialiseLead) });
}
