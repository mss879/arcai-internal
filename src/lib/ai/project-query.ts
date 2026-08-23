import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isOpenAIConfigured, openaiChatJSON } from "@/lib/ai/openai";
import { SERVICE_TYPE_LABELS } from "@/lib/constants";
import type { Database } from "@/lib/database.types";
import { balanceDue, projectMargin, settledAmount } from "@/lib/projects";

type DB = SupabaseClient<Database>;

/**
 * Ask your projects anything (AI-8).
 *
 * "Which clients still owe money on delivered work?" "What did we spend on
 * hosting last quarter?" Both answerable from data already stored, neither
 * answerable without building a report for each one.
 *
 * The model NEVER writes SQL and never touches the database. Every project is
 * loaded through the same money helpers the rest of the app uses, flattened
 * into a small table, and handed to the model as facts — which it filters,
 * sorts and explains. Slower than SQL generation and immune to it: there is
 * no query for a prompt to smuggle, and the totals cannot disagree with the
 * board because they are computed by the same functions.
 *
 * The ceiling is the workspace size, not the model's context: at a few hundred
 * projects the flattened table is a few hundred short rows.
 */

export type ProjectAnswer = {
  answer: string;
  /** The rows the answer rests on, so it can be checked and acted on. */
  rows: { project: string; client: string; detail: string; href: string }[];
};

const MAX_PROJECTS = 250;

const PROMPT = `You answer questions about a Sri Lankan digital agency's projects, using ONLY the table of facts provided.

Return STRICT JSON:
{
  "answer": string,     // 1-4 sentences answering the question directly. Quote real figures. Plain text, no markdown.
  "rows": [ { "id": string, "detail": string } ]   // the projects the answer rests on, most relevant first, max 20
}

Rules:
- Use ONLY the rows given. If the data cannot answer the question, say exactly that and return an empty rows array — never guess.
- "detail" is the one fact from that row that makes it an answer, e.g. "LKR 45,000 outstanding since 12 Jun".
- Every id in rows MUST be one of the ids in the table.
- Money is in each project's own currency; do not add different currencies together.
- If the question is about something not in the table (staff salaries, bank balances, anything outside projects), say so plainly.
- Output JSON only.`;

export async function askProjects(
  supabase: DB,
  question: string,
): Promise<{ ok: true; result: ProjectAnswer } | { ok: false; error: string }> {
  if (!isOpenAIConfigured())
    return { ok: false, error: "OPENAI_API_KEY is not configured." };
  const q = question.trim();
  if (!q) return { ok: false, error: "Ask a question first." };

  const { data: rows } = await supabase
    .from("projects")
    .select(
      "id, name, status, service_type, currency, total_value, deposit_paid, start_date, due_date, created_at, delivery_stage, delivery_stage_changed_at, blocked_reason, client:clients(name), payments(amount, status), company_payments(price_lkr, is_paid)",
    )
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(MAX_PROJECTS);

  if (!rows?.length)
    return { ok: false, error: "There are no projects to ask about yet." };

  const ids = rows.map((r) => r.id);
  const [{ data: expenses }, { data: commissions }] = await Promise.all([
    supabase
      .from("project_expenses")
      .select("project_id, amount, billable, category, description, incurred_on")
      .in("project_id", ids),
    supabase
      .from("commissions")
      .select("project_id, amount, percentage, basis")
      .in("project_id", ids),
  ]);

  const facts = rows.map((row) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = row as any;
    const received = settledAmount({
      deposit_paid: r.deposit_paid,
      payments: r.payments ?? [],
      company_payments: r.company_payments ?? [],
    });
    const balance = balanceDue({
      total_value: r.total_value,
      deposit_paid: r.deposit_paid,
      payments: r.payments ?? [],
      company_payments: r.company_payments ?? [],
    });
    const mine = (expenses ?? []).filter((e) => e.project_id === r.id);
    const margin = projectMargin({
      totalValue: Number(r.total_value) || 0,
      expenses: mine,
      commissions: (commissions ?? [])
        .filter((c) => c.project_id === r.id)
        .map((c) => ({
          amount:
            c.basis === "percent_of_received" && c.percentage
              ? (received * Number(c.percentage)) / 100
              : Number(c.amount) || 0,
        })),
    });

    // Expense categories are folded to a total each, so "what did we spend on
    // hosting" is answerable without shipping every line item.
    const byCategory = new Map<string, number>();
    for (const e of mine) {
      const key = (e.category || "uncategorised").toLowerCase();
      byCategory.set(key, (byCategory.get(key) ?? 0) + Number(e.amount ?? 0));
    }

    return {
      id: r.id,
      name: r.name,
      client: r.client?.name ?? "no client",
      status: r.status,
      service:
        (SERVICE_TYPE_LABELS[
          r.service_type as keyof typeof SERVICE_TYPE_LABELS
        ] ?? r.service_type) || "unspecified",
      stage: r.delivery_stage ?? "not started",
      currency: r.currency || "LKR",
      value: Math.round(Number(r.total_value) || 0),
      received: Math.round(received),
      outstanding: Math.round(balance),
      costs: Math.round(margin.expenses),
      margin_percent: margin.percent,
      started: r.start_date,
      due: r.due_date,
      created: String(r.created_at).slice(0, 10),
      delivered_on:
        r.delivery_stage === "delivered" || r.delivery_stage === "aftercare"
          ? String(r.delivery_stage_changed_at ?? "").slice(0, 10) || null
          : null,
      blocked: r.blocked_reason ?? null,
      spend_by_category: Object.fromEntries(
        [...byCategory.entries()].map(([k, v]) => [k, Math.round(v)]),
      ),
    };
  });

  try {
    const raw = await openaiChatJSON(
      [
        { role: "system", content: PROMPT },
        {
          role: "user",
          content: `TODAY: ${new Date().toISOString().slice(0, 10)}\n\nQUESTION: ${q}\n\nPROJECTS (one JSON object per line):\n${facts
            .map((f) => JSON.stringify(f))
            .join("\n")}`,
        },
      ],
      { temperature: 0.2, timeoutMs: 60_000 },
    );

    const parsed = JSON.parse(raw) as { answer?: unknown; rows?: unknown };
    const byId = new Map(facts.map((f) => [f.id, f]));

    return {
      ok: true,
      result: {
        answer:
          typeof parsed.answer === "string"
            ? parsed.answer.trim()
            : "No answer came back.",
        rows: Array.isArray(parsed.rows)
          ? parsed.rows
              .filter(
                (r): r is { id: string; detail?: unknown } =>
                  !!r && typeof (r as { id?: unknown }).id === "string",
              )
              // Only ids that really exist — a hallucinated row would
              // otherwise become a dead link the reader trusts.
              .filter((r) => byId.has(r.id))
              .map((r) => {
                const fact = byId.get(r.id)!;
                return {
                  project: fact.name,
                  client: fact.client,
                  detail:
                    typeof r.detail === "string" ? r.detail.trim().slice(0, 200) : "",
                  href: `/projects/${fact.id}`,
                };
              })
              .slice(0, 20)
          : [],
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "The question could not be answered.",
    };
  }
}
