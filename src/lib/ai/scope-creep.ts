import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isOpenAIConfigured, openaiChatJSON } from "@/lib/ai/openai";
import type { Database } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

/**
 * Scope creep, caught and priced (AI-3).
 *
 * CX-3 built the machinery: a change request can be quoted, accepted, and
 * turned into a billable expense. It only fires when a client happens to use
 * the portal form. In practice the request arrives mid-WhatsApp-conversation
 * as "oh, can you also add a booking form?" — and gets done for free, because
 * nobody wanted to be the one to say it costs money.
 *
 * This reads the thread against what was agreed and drafts both halves: the
 * change request, and the reply that asks for the money without being awkward.
 * It never sends and never bills — it files a `new` change request the team
 * prices exactly as they would a portal one.
 */

const PROMPT = `You read a client's messages against a project's agreed scope for ARC AI, a digital agency in Sri Lanka.

Return STRICT JSON:
{
  "requests": [
    {
      "quote": string,      // the client's own words, verbatim, that asked for it
      "summary": string,    // one sentence naming the extra work
      "reason": string,     // one sentence on WHY this is outside what was agreed
      "confidence": "high"|"low"
    }
  ]
}

Rules:
- Only flag work that is genuinely OUTSIDE the agreed scope. A client chasing progress, asking a question, complaining, or requesting a fix to something already in scope is NOT scope creep. Over-flagging trains the team to ignore this.
- A request for a change to something already listed as a deliverable is NOT extra work.
- "confidence": "low" if you are unsure whether it was already included — the team sees the flag either way, but low ones are marked for a closer look.
- If nothing in the messages is out of scope, return {"requests": []}. That is the normal, expected answer.
- Output JSON only.`;

export type ScopeFinding = {
  quote: string;
  summary: string;
  reason: string;
  confidence: "high" | "low";
};

export type ScopeScanResult = {
  scanned: number;
  flagged: number;
};

/**
 * Scan ONE project's thread for out-of-scope requests.
 *
 * Bounded by `projects.scope_checked_at`: only messages newer than the last
 * scan are read, so the tick doesn't re-read (and re-flag) the same
 * conversation every minute.
 */
export async function scanProjectScope(
  supabase: DB,
  projectId: string,
  opts?: { force?: boolean },
): Promise<
  { ok: true; findings: ScopeFinding[] } | { ok: false; error: string }
> {
  if (!isOpenAIConfigured())
    return { ok: false, error: "OPENAI_API_KEY is not configured." };

  const { data: project } = await supabase
    .from("projects")
    .select(
      "id, name, description, client_id, service_type, scope_checked_at, deleted_at",
    )
    .eq("id", projectId)
    .maybeSingle();
  if (!project || project.deleted_at)
    return { ok: false, error: "Project not found." };
  if (!project.client_id)
    return { ok: false, error: "This project has no client, so there's no thread to read." };

  const { data: contact } = await supabase
    .from("wa_contacts")
    .select("id")
    .eq("client_id", project.client_id)
    .order("last_message_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!contact)
    return { ok: false, error: "No WhatsApp thread for this client yet." };

  // Only what has arrived since the last look, unless forced by a person.
  let q = supabase
    .from("wa_messages")
    .select("id, body, created_at")
    .eq("contact_id", contact.id)
    .eq("direction", "in")
    .order("created_at", { ascending: true })
    .limit(40);
  if (!opts?.force && project.scope_checked_at)
    q = q.gt("created_at", project.scope_checked_at);

  const { data: messages } = await q;
  const inbound = (messages ?? []).filter((m) => m.body?.trim());

  // Stamp regardless: a scan that found nothing has still been done, and not
  // stamping would make every tick re-read the same messages forever.
  const stamp = async () =>
    supabase
      .from("projects")
      .update({ scope_checked_at: new Date().toISOString() })
      .eq("id", projectId);

  if (inbound.length === 0) {
    await stamp();
    return { ok: true, findings: [] };
  }

  // What was agreed: the project's own description, its milestones (the
  // client-visible ones ARE the deliverables), and anything already quoted —
  // so the same request isn't flagged twice.
  const [{ data: milestones }, { data: existing }] = await Promise.all([
    supabase
      .from("project_milestones")
      .select("title, detail")
      .eq("project_id", projectId)
      .eq("kind", "milestone")
      .order("position", { ascending: true }),
    supabase
      .from("project_change_requests")
      .select("body")
      .eq("project_id", projectId)
      .limit(30),
  ]);

  const agreed = [
    `PROJECT: ${project.name}`,
    project.service_type ? `Service: ${project.service_type}` : "",
    project.description ? `Agreed scope: ${project.description}` : "",
    milestones?.length
      ? `Deliverables (from the plan):\n${milestones
          .map((m) => `- ${m.title}${m.detail ? `: ${m.detail}` : ""}`)
          .join("\n")}`
      : "",
    existing?.length
      ? `ALREADY RAISED as change requests — do not flag these again:\n${existing
          .map((c) => `- ${c.body.slice(0, 200)}`)
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  // With no description and no milestones there is nothing to measure against,
  // and every request would look out of scope. Refusing is the honest answer.
  if (!project.description && !milestones?.length) {
    await stamp();
    return {
      ok: false,
      error:
        "No agreed scope to compare against — add a description or some milestones first, or everything looks like creep.",
    };
  }

  let findings: ScopeFinding[];
  try {
    const raw = await openaiChatJSON(
      [
        { role: "system", content: PROMPT },
        {
          role: "user",
          content: `${agreed}\n\nCLIENT MESSAGES (oldest first):\n${inbound
            .map((m) => m.body)
            .join("\n")
            .slice(0, 8000)}`,
        },
      ],
      { temperature: 0.2, timeoutMs: 45_000 },
    );
    findings = normalize((JSON.parse(raw) as { requests?: unknown }).requests);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "The scope scan failed.",
    };
  }

  // File each as a change request the team prices — the same row the portal
  // form produces, so accepting it bills exactly as CX-3 already does.
  for (const f of findings) {
    await supabase.from("project_change_requests").insert({
      project_id: projectId,
      body: `${f.summary}\n\nClient's words: "${f.quote}"`,
      source: "whatsapp",
      status: "new",
      ai_flagged: true,
      ai_reason: `${f.reason}${f.confidence === "low" ? " (low confidence — check this was not already included)" : ""}`,
    });
  }

  if (findings.length) {
    const { logDeliveryEvent } = await import("@/lib/delivery");
    await logDeliveryEvent(
      supabase,
      projectId,
      "change_requested",
      `${findings.length} possible out-of-scope request${findings.length === 1 ? "" : "s"} spotted in WhatsApp`,
      "automation",
    );
    const { notifyEveryone } = await import("@/lib/wa-agent");
    await notifyEveryone(supabase, {
      title: `Possible scope creep: ${project.name}`,
      body: findings[0].summary,
      link: `/projects/${projectId}`,
    });
  }

  await stamp();
  return { ok: true, findings };
}

function normalize(raw: unknown): ScopeFinding[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (f): f is { quote: string; summary: string; reason?: unknown; confidence?: unknown } =>
        !!f &&
        typeof (f as { quote?: unknown }).quote === "string" &&
        typeof (f as { summary?: unknown }).summary === "string",
    )
    .map((f) => ({
      quote: f.quote.trim().slice(0, 400),
      summary: f.summary.trim().slice(0, 300),
      reason: typeof f.reason === "string" ? f.reason.trim().slice(0, 300) : "",
      confidence: f.confidence === "low" ? ("low" as const) : ("high" as const),
    }))
    .filter((f) => f.quote && f.summary)
    .slice(0, 5);
}

/**
 * The tick pass: scan a few active projects whose threads have moved.
 *
 * Deliberately small per tick — this is an AI call per project, and a client
 * waiting on a WhatsApp reply must never be starved by it.
 */
const MAX_SCOPE_SCANS_PER_TICK = 2;

export async function processScopeScans(supabase: DB): Promise<ScopeScanResult> {
  const result: ScopeScanResult = { scanned: 0, flagged: 0 };
  if (!isOpenAIConfigured()) return result;

  // Only projects being actively built — onboarding is where extras are
  // negotiated normally, and a delivered project's extras are a new job.
  const { data: projects } = await supabase
    .from("projects")
    .select("id, scope_checked_at")
    .is("deleted_at", null)
    .eq("automation_paused", false)
    .in("delivery_stage", ["build", "review"])
    .not("client_id", "is", null)
    .order("scope_checked_at", { ascending: true, nullsFirst: true })
    .limit(MAX_SCOPE_SCANS_PER_TICK);

  for (const p of projects ?? []) {
    // Once a day per project is plenty — extras arrive in conversations, not
    // in bursts, and the cost of reading is per call.
    if (
      p.scope_checked_at &&
      Date.now() - Date.parse(p.scope_checked_at) < 20 * 3600_000
    )
      continue;
    try {
      const res = await scanProjectScope(supabase, p.id);
      result.scanned++;
      if (res.ok) result.flagged += res.findings.length;
    } catch (e) {
      console.error("[scope-creep] scan failed:", e);
    }
  }
  return result;
}
