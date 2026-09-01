import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isOpenAIConfigured, openaiChatJSON } from "@/lib/ai/openai";
import type { Database } from "@/lib/database.types";
import { balanceDue, daysSince, projectHealth } from "@/lib/projects";

type DB = SupabaseClient<Database>;

/**
 * The nightly risk radar (AI-4).
 *
 * PLAN-8 already scores every project's health, and the board already shows a
 * red dot. What it can't do is say which THREE of the seven red dots to spend
 * today on, or why — and a wall of amber trains people to ignore all of it.
 *
 * One pass a night ranks the open projects and writes one plain sentence per
 * project saying what to do about it. Stored on the row so the board, the
 * dashboard and the morning digest all read the same answer rather than each
 * inventing their own.
 *
 * The RANKING is arithmetic (projectHealth + money + deadline), so it works
 * with no API key at all. The model only writes the sentence.
 */

export type RiskRadarResult = { ranked: number; wrote: boolean };

/** How many projects get a written reason. Beyond this, ranking only. */
const NARRATE_TOP = 8;

/** Once a day — the pass is called every tick and gates itself. */
const MIN_HOURS_BETWEEN_PASSES = 20;

type Candidate = {
  id: string;
  name: string;
  score: number;
  reasons: string[];
  balance: number;
  currency: string;
  dueDate: string | null;
  daysOverdue: number | null;
  stage: string | null;
  idleDays: number | null;
  assetsOutstanding: number;
  overdueTasks: number;
};

export async function processRiskRadar(supabase: DB): Promise<RiskRadarResult> {
  const result: RiskRadarResult = { ranked: 0, wrote: false };

  // Self-gating: the most recently checked project tells us when the last
  // pass ran, so no extra bookkeeping row is needed.
  const { data: last } = await supabase
    .from("projects")
    .select("risk_checked_at")
    .not("risk_checked_at", "is", null)
    .order("risk_checked_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (
    last?.risk_checked_at &&
    Date.now() - Date.parse(last.risk_checked_at) <
      MIN_HOURS_BETWEEN_PASSES * 3600_000
  )
    return result;

  const { data: rows } = await supabase
    .from("projects")
    .select(
      "id, name, status, currency, total_value, deposit_paid, due_date, delivery_stage, delivery_stage_changed_at, updated_at, blocked_since, expense_cap, budget, payments(amount, status), company_payments(price_lkr, is_paid)",
    )
    .is("deleted_at", null)
    .in("status", ["planning", "active", "on_hold"])
    .limit(200);
  if (!rows?.length) return result;

  const ids = rows.map((r) => r.id);
  const [
    { data: assets },
    { data: tasks },
    { data: milestones },
    { data: financeCosts },
    { data: expenses },
  ] =
    await Promise.all([
      supabase
        .from("project_document_requests")
        .select("project_id, status, required")
        .in("project_id", ids),
      supabase
        .from("todos")
        .select("project_id, status, due_date")
        .in("project_id", ids),
      supabase
        .from("project_milestones")
        .select("project_id, status, due_date")
        .in("project_id", ids),
      // 0100 — Finance costs count against the cap the same as project ones.
      supabase
        .from("expenses")
        .select("project_id, amount")
        .in("project_id", ids),
      supabase
        .from("project_expenses")
        .select("project_id, amount")
        .in("project_id", ids),
    ]);

  const today = new Date().toISOString().slice(0, 10);
  const todayMs = Date.parse(`${today}T00:00:00Z`);

  const candidates: Candidate[] = rows.map((row) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = row as any;
    const balance = balanceDue({
      total_value: r.total_value,
      deposit_paid: r.deposit_paid,
      payments: r.payments ?? [],
      company_payments: r.company_payments ?? [],
    });
    const assetsOutstanding = (assets ?? []).filter(
      (a) => a.project_id === r.id && a.status === "pending" && a.required,
    ).length;
    const overdueTasks = (tasks ?? []).filter(
      (t) =>
        t.project_id === r.id &&
        t.status !== "done" &&
        t.due_date &&
        Date.parse(t.due_date) < todayMs,
    ).length;
    const overdueMilestones = (milestones ?? []).filter(
      (m) =>
        m.project_id === r.id &&
        m.status !== "done" &&
        m.due_date &&
        Date.parse(`${m.due_date}T23:59:59Z`) < todayMs,
    ).length;
    const spend = [...(expenses ?? []), ...(financeCosts ?? [])]
      .filter((e) => e.project_id === r.id)
      .reduce((sum, e) => sum + Number(e.amount ?? 0), 0);

    const health = projectHealth({
      status: r.status,
      deliveryStage: r.delivery_stage,
      stageChangedAt: r.delivery_stage_changed_at,
      updatedAt: r.updated_at,
      dueDate: r.due_date,
      blockedSince: r.blocked_since,
      assetsOutstanding,
      overdueTasks,
      overdueMilestones,
      balance,
      daysSinceDelivered: null,
      budget: Number(r.expense_cap ?? r.budget ?? 0) || null,
      spend,
    });

    const daysOverdue =
      r.due_date && r.due_date < today
        ? Math.round((todayMs - Date.parse(`${r.due_date}T00:00:00Z`)) / (24 * 3600_000))
        : null;

    return {
      id: r.id,
      name: r.name,
      score: health.score,
      reasons: health.reasons,
      balance,
      currency: r.currency || "LKR",
      dueDate: r.due_date,
      daysOverdue,
      stage: r.delivery_stage,
      idleDays: daysSince(r.delivery_stage_changed_at ?? r.updated_at),
      assetsOutstanding,
      overdueTasks,
    };
  });

  /**
   * Rank: health first, then money at stake, then how late it is.
   *
   * Money breaks ties deliberately. Two equally unhealthy projects are not
   * equally urgent if one of them is owed nothing.
   */
  const ranked = candidates
    .filter((c) => c.score < 100 || c.daysOverdue !== null)
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (a.balance !== b.balance) return b.balance - a.balance;
      return (b.daysOverdue ?? 0) - (a.daysOverdue ?? 0);
    });

  const stampedAt = new Date().toISOString();

  // Clear last night's ranking wholesale, so a project that recovered stops
  // being listed rather than lingering at rank 4 forever.
  await supabase
    .from("projects")
    .update({ risk_rank: null, risk_note: null, risk_checked_at: stampedAt })
    .is("deleted_at", null)
    .not("risk_rank", "is", null);

  if (ranked.length === 0) return result;

  // The written reasons — one call for the whole top slice, not one per
  // project: the model needs to see them together to say "these three".
  let notes = new Map<string, string>();
  if (isOpenAIConfigured()) {
    notes = await narrate(ranked.slice(0, NARRATE_TOP));
    result.wrote = notes.size > 0;
  }

  for (let i = 0; i < ranked.length; i++) {
    const c = ranked[i];
    await supabase
      .from("projects")
      .update({
        risk_rank: i + 1,
        // Falls back to the health engine's own sentence, so the radar is
        // useful with no API key at all.
        risk_note: notes.get(c.id) ?? c.reasons[0] ?? null,
        risk_checked_at: stampedAt,
      })
      .eq("id", c.id);
    result.ranked++;
  }

  // Tell the team about the top three, once, with the reason attached.
  const top = ranked.slice(0, 3);
  if (top.length) {
    const { notifyEveryone } = await import("@/lib/wa-agent");
    await notifyEveryone(supabase, {
      title: `${top.length} project${top.length === 1 ? "" : "s"} need you today`,
      body: top
        .map((c) => `${c.name} — ${notes.get(c.id) ?? c.reasons[0] ?? "at risk"}`)
        .join(" · "),
      link: "/projects?sort=health",
    });
  }

  return result;
}

const NARRATE_PROMPT = `You are the delivery lead at ARC AI, a Sri Lankan digital agency, triaging projects for the day.

You are given projects already ranked worst-first by an arithmetic health score. For each, write ONE sentence saying what is actually wrong and what to do about it today.

Return STRICT JSON:
{ "notes": [ { "id": string, "note": string } ] }

Rules:
- One sentence each, under 140 characters. No markdown, no emoji.
- Say the ACTION, not the diagnosis: "Chase the logo — the build has been blocked on it for 9 days" beats "Assets outstanding".
- Use only the facts given. Never invent a client's reaction or a deadline that isn't listed.
- Include every project you were given, keyed by its id.
- Output JSON only.`;

async function narrate(top: Candidate[]): Promise<Map<string, string>> {
  const notes = new Map<string, string>();
  try {
    const raw = await openaiChatJSON(
      [
        { role: "system", content: NARRATE_PROMPT },
        {
          role: "user",
          content: top
            .map((c) =>
              [
                `id: ${c.id}`,
                `name: ${c.name}`,
                `health score: ${c.score}/100`,
                `problems: ${c.reasons.join("; ") || "none flagged"}`,
                c.balance > 0
                  ? `unpaid balance: ${c.currency} ${Math.round(c.balance).toLocaleString()}`
                  : "fully paid",
                c.daysOverdue !== null
                  ? `OVERDUE by ${c.daysOverdue} days (due ${c.dueDate})`
                  : c.dueDate
                    ? `due ${c.dueDate}`
                    : "no due date set",
                `stage: ${c.stage ?? "not started"}${c.idleDays !== null ? `, idle ${c.idleDays} days` : ""}`,
                c.assetsOutstanding
                  ? `waiting on ${c.assetsOutstanding} required asset(s) from the client`
                  : "",
                c.overdueTasks ? `${c.overdueTasks} overdue task(s)` : "",
              ]
                .filter(Boolean)
                .join("\n"),
            )
            .join("\n---\n"),
        },
      ],
      { temperature: 0.3, timeoutMs: 20_000 },
    );
    const parsed = JSON.parse(raw) as { notes?: unknown };
    if (Array.isArray(parsed.notes)) {
      for (const n of parsed.notes) {
        if (
          n &&
          typeof (n as { id?: unknown }).id === "string" &&
          typeof (n as { note?: unknown }).note === "string"
        ) {
          const entry = n as { id: string; note: string };
          notes.set(entry.id, entry.note.trim().slice(0, 200));
        }
      }
    }
  } catch (e) {
    console.error("[risk-radar] narration failed:", e);
  }
  return notes;
}
