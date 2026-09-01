import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { isOpenAIConfigured, openaiChatJSON } from "@/lib/ai/openai";
import { currentWeekStart } from "@/lib/intelligence";

type DB = SupabaseClient<Database>;

/**
 * The self-improving playbook: once a week (from the digest cron) this reads
 * the WhatsApp agent's own conversations — what got replies, where people
 * ghosted, which deals were won or lost — and distils 5-8 coaching bullets.
 * The newest active row is injected straight into the agent's system prompt,
 * so the agent literally gets better at selling every week.
 */

const LOOKBACK_DAYS = 14;
const GHOST_AFTER_MS = 48 * 3600_000;

type ConversationDigest = {
  name: string;
  outcome: string;
  inbound: number;
  outbound: number;
  ghosted: boolean;
  last_agent_message: string;
};

export async function analyzeWaSalesWeek(
  supabase: DB,
): Promise<{ ok: boolean; notes?: string }> {
  if (!isOpenAIConfigured()) return { ok: false };

  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();

  const [{ data: contacts }, { data: messages }, { data: logs }] = await Promise.all([
    supabase
      .from("wa_contacts")
      .select("id, display_name, profile_name, lead_id")
      .limit(200),
    supabase
      .from("wa_messages")
      .select("contact_id, direction, body, sent_by, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(2000),
    supabase
      .from("wa_agent_logs")
      .select("tool, ok")
      .gte("created_at", since)
      .limit(1000),
  ]);
  if (!messages?.length) return { ok: false };

  const leadIds = (contacts ?? []).map((c) => c.lead_id).filter(Boolean) as string[];
  const { data: leads } = leadIds.length
    ? await supabase.from("leads").select("id, status, value").in("id", leadIds)
    : { data: [] as { id: string; status: string; value: number | null }[] };
  const leadById = new Map((leads ?? []).map((l) => [l.id, l]));

  // Per-conversation digests + full tails of ghosted threads for the coach.
  const byContact = new Map<string, typeof messages>();
  for (const m of messages) {
    const list = byContact.get(m.contact_id) ?? [];
    list.push(m);
    byContact.set(m.contact_id, list);
  }

  const digests: ConversationDigest[] = [];
  const ghostTails: string[] = [];
  for (const contact of contacts ?? []) {
    const thread = byContact.get(contact.id);
    if (!thread?.length) continue;
    const last = thread[thread.length - 1];
    const ghosted =
      last.direction === "out" &&
      Date.now() - new Date(last.created_at).getTime() > GHOST_AFTER_MS;
    const lead = contact.lead_id ? leadById.get(contact.lead_id) : null;
    const lastAgent = [...thread].reverse().find((m) => m.direction === "out");
    digests.push({
      name: contact.display_name || contact.profile_name || "unknown",
      outcome: lead ? `${lead.status}${lead.value ? ` (Rs ${lead.value})` : ""}` : "no lead",
      inbound: thread.filter((m) => m.direction === "in").length,
      outbound: thread.filter((m) => m.direction === "out").length,
      ghosted,
      last_agent_message: (lastAgent?.body ?? "").slice(0, 180),
    });
    if (ghosted && ghostTails.length < 5) {
      ghostTails.push(
        thread
          .slice(-6)
          .map((m) => `${m.direction === "in" ? "CUSTOMER" : "AGENT"}: ${m.body.slice(0, 200)}`)
          .join("\n"),
      );
    }
  }
  if (!digests.length) return { ok: false };

  const toolUse: Record<string, number> = {};
  for (const log of logs ?? []) {
    toolUse[log.tool] = (toolUse[log.tool] ?? 0) + 1;
  }
  const stats = {
    lookback_days: LOOKBACK_DAYS,
    conversations: digests.length,
    ghosted: digests.filter((d) => d.ghosted).length,
    won: digests.filter((d) => d.outcome.startsWith("won")).length,
    lost: digests.filter((d) => d.outcome.startsWith("lost")).length,
    tool_use: toolUse,
  };

  const raw = await openaiChatJSON(
    [
      {
        role: "system",
        content:
          "You are a ruthless but constructive WhatsApp sales coach. You analyze an AI sales agent's real conversations and produce concrete behavioural coaching the agent will follow next week. Focus on MESSAGING BEHAVIOUR: message length, question quality, when to push vs when to give space, what preceded ghosting, what preceded wins. Never suggest changing prices or inventing offers. Output ONLY JSON.",
      },
      {
        role: "user",
        content: `Stats: ${JSON.stringify(stats)}

Per-conversation digests:
${JSON.stringify(digests.slice(0, 40))}

Last messages of ghosted threads (what the agent said right before silence):
${ghostTails.join("\n---\n") || "(none)"}

Return JSON: { "notes": ["...", "..."] } — 5 to 8 short, specific coaching bullets (max ~22 words each) the agent should apply next week. Base every bullet on the evidence above, not generic sales advice.`,
      },
    ],
    { temperature: 0.4, timeoutMs: 20_000 },
  );

  let notes: string[] = [];
  try {
    const parsed = JSON.parse(raw) as { notes?: unknown };
    if (Array.isArray(parsed.notes)) {
      notes = parsed.notes
        .map((n) => String(n).trim())
        .filter(Boolean)
        .slice(0, 8);
    }
  } catch {
    return { ok: false };
  }
  if (!notes.length) return { ok: false };

  const bullets = notes.map((n) => `- ${n}`).join("\n");
  const { error } = await supabase.from("wa_coaching").upsert(
    {
      week_start: currentWeekStart(),
      stats: stats as unknown as Record<string, unknown>,
      notes: bullets,
      is_active: true,
    },
    { onConflict: "week_start" },
  );
  if (error) {
    console.error("[wa-coaching] save failed:", error.message);
    return { ok: false };
  }

  // The bullets no longer self-apply. wa_coaching keeps the weekly history
  // (and the stats the Analytics tab reads), but what the agent actually
  // follows is the approve-first wa_lessons queue — each fresh bullet lands
  // there as `pending` for the team's yes. Exact repeats of anything already
  // queued or approved are skipped.
  const { data: existing } = await supabase
    .from("wa_lessons")
    .select("body")
    .in("status", ["pending", "approved"]);
  const seen = new Set(
    (existing ?? []).map((l) => l.body.trim().toLowerCase()),
  );
  const rows = notes
    .filter((n) => !seen.has(n.trim().toLowerCase()))
    .map((n) => ({
      kind: "playbook" as const,
      title: n.length > 80 ? `${n.slice(0, 77)}…` : n,
      body: n,
      source: "weekly_coach" as const,
      evidence: { stats } as unknown as Record<string, unknown>,
    }));
  if (rows.length) {
    const { error: queueError } = await supabase.from("wa_lessons").insert(rows);
    if (queueError)
      console.error(
        "[wa-coaching] lesson queue insert failed (is migration 0073 applied?):",
        queueError.message,
      );
  }

  return { ok: true, notes: bullets };
}

/**
 * The scheduler for the above.
 *
 * analyzeWaSalesWeek was only ever reachable from /api/intelligence/digest,
 * and nothing scheduled that route — so the "self-improving playbook" never
 * ran once and wa_coaching stayed empty. The automation tick now calls this
 * every minute, behind two gates:
 *
 *   1. this week already has notes → nothing to do
 *   2. we already tried today → wait until tomorrow
 *
 * The second gate matters because the analysis reads up to 2000 messages and
 * makes an OpenAI call; without it, a week with too little data (or a flaky
 * key) would re-run that every 60 seconds for seven days. Claim-first on the
 * date, mirroring processColdDigest, so concurrent ticks can't both run it.
 */
export async function processWaCoaching(
  supabase: DB,
): Promise<{ ran: boolean }> {
  try {
    if (!isOpenAIConfigured()) return { ran: false };

    const { data: config } = await supabase
      .from("wa_agent_config")
      .select("timezone, coaching_ran_for")
      .eq("id", 1)
      .maybeSingle();
    if (!config) return { ran: false };

    // Already have this week's lessons.
    const { data: existing } = await supabase
      .from("wa_coaching")
      .select("week_start")
      .eq("week_start", currentWeekStart())
      .limit(1)
      .maybeSingle();
    if (existing) return { ran: false };

    const today = localDateInTimezone(config.timezone || "Asia/Colombo");
    if (config.coaching_ran_for === today) return { ran: false };

    const { data: claimed } = await supabase
      .from("wa_agent_config")
      .update({ coaching_ran_for: today })
      .eq("id", 1)
      .or(`coaching_ran_for.is.null,coaching_ran_for.neq.${today}`)
      .select("id");
    if (!claimed?.length) return { ran: false };

    const result = await analyzeWaSalesWeek(supabase);
    return { ran: result.ok };
  } catch (e) {
    console.error("[wa-coaching] weekly run failed:", e);
    return { ran: false };
  }
}

/** Calendar date in the workspace's timezone (YYYY-MM-DD). */
export function localDateInTimezone(timezone: string, at = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}
