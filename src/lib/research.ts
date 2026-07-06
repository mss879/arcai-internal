import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import {
  researchCompany,
  isResearchConfigured,
  type ResearchInput,
} from "@/lib/ai/lead-research";

type DB = SupabaseClient<Database>;

export type ResearchTickResult = { processed: number; failed: number };

/** Rows stuck in `running` longer than this are assumed dead and retried. */
const STUCK_AFTER_MS = 5 * 60 * 1000;

/**
 * Queue a research report for a lead. Upserts a `pending` row (one per
 * lead, unique index) so the automation tick — or an immediate inline
 * run — will pick it up. Safe to call repeatedly; re-queuing resets an
 * existing report back to pending. Never throws (fire-and-forget from
 * the lead-create path).
 */
export async function queueLeadResearch(
  supabase: DB,
  opts: { leadId: string; company: string; requestedBy?: string | null },
): Promise<{ ok: boolean; id?: string }> {
  const company = opts.company.trim();
  if (!company) return { ok: false };

  try {
    const { data, error } = await supabase
      .from("lead_research")
      .upsert(
        {
          lead_id: opts.leadId,
          company_name: company,
          status: "pending",
          error: null,
          ...(opts.requestedBy ? { requested_by: opts.requestedBy } : {}),
        },
        { onConflict: "lead_id" },
      )
      .select("id")
      .single();
    if (error) {
      console.error("[research] queue failed:", error.message);
      return { ok: false };
    }
    return { ok: true, id: data.id };
  } catch (e) {
    console.error("[research] queue threw:", e);
    return { ok: false };
  }
}

/**
 * Queue a report and run it immediately in the same call. Used by the
 * manual "Run research" button and the lead-create hook (inside
 * `after()`). If the run outlives the serverless function's budget the
 * row is left `pending`/`running` for the automation tick to retry, so
 * a report is never lost. Never throws.
 */
export async function startLeadResearch(
  supabase: DB,
  opts: { leadId: string; company: string; requestedBy?: string | null },
): Promise<{ ok: boolean; id?: string }> {
  const queued = await queueLeadResearch(supabase, opts);
  if (!queued.ok || !queued.id) return queued;

  await runResearchRow(supabase, {
    id: queued.id,
    lead_id: opts.leadId,
    company_name: opts.company.trim(),
  });
  return queued;
}

/** Pull the lead fields that sharpen the searches. */
async function researchInputForLead(
  supabase: DB,
  leadId: string,
  fallbackCompany: string,
): Promise<ResearchInput> {
  const { data: lead } = await supabase
    .from("leads")
    .select("company, contact_name, company_id")
    .eq("id", leadId)
    .maybeSingle();

  let website: string | null = null;
  let industry: string | null = null;
  let location: string | null = null;
  if (lead?.company_id) {
    const { data: company } = await supabase
      .from("companies")
      .select("website, industry, city")
      .eq("id", lead.company_id)
      .maybeSingle();
    website = company?.website ?? null;
    industry = company?.industry ?? null;
    location = company?.city ?? null;
  }

  return {
    company: lead?.company?.trim() || fallbackCompany,
    website,
    industry,
    location,
    contactName: lead?.contact_name ?? null,
  };
}

/** Outcome of a single run: `done`/`error` did the work, `skipped` lost the claim. */
export type RunOutcome = "done" | "error" | "skipped";

/**
 * Run research for a single `lead_research` row end to end: atomically
 * claim it (pending → running), gather + synthesise, then persist the
 * report (or an error). Used by both the inline server action and the
 * tick — the claim is a compare-and-swap so those two callers can never
 * both process the same row (no doubled Firecrawl/OpenAI spend). Returns
 * `skipped` when another worker already owns the row. Never throws.
 */
export async function runResearchRow(
  supabase: DB,
  row: { id: string; lead_id: string; company_name: string },
): Promise<RunOutcome> {
  // Atomic claim: only win rows that are pending, previously errored, or a
  // `running` row that's been stale long enough to be considered dead. The
  // WHERE is applied in one statement, so exactly one caller flips it.
  const stuckBefore = new Date(Date.now() - STUCK_AFTER_MS).toISOString();
  const { data: claimed } = await supabase
    .from("lead_research")
    .update({ status: "running" })
    .eq("id", row.id)
    .or(
      `status.eq.pending,status.eq.error,and(status.eq.running,updated_at.lt.${stuckBefore})`,
    )
    .select("id");
  if (!claimed?.length) return "skipped";

  try {
    const input = await researchInputForLead(
      supabase,
      row.lead_id,
      row.company_name,
    );
    const { report, sources } = await researchCompany(input);

    const { error } = await supabase
      .from("lead_research")
      .update({
        status: "done",
        error: null,
        report,
        sources,
        company_name: input.company,
      })
      .eq("id", row.id);
    if (error) {
      console.error("[research] persist failed:", error.message);
      return "error";
    }
    return "done";
  } catch (e) {
    console.error("[research] run failed:", e);
    await supabase
      .from("lead_research")
      .update({
        status: "error",
        error: e instanceof Error ? e.message : "Research failed.",
      })
      .eq("id", row.id);
    return "error";
  }
}

/**
 * Process queued research from the automation tick. Picks up freshly
 * `pending` rows plus any that got stuck in `running` (a serverless
 * function that timed out mid-run) and runs them, letting the atomic
 * claim in `runResearchRow` ensure an inline run and the tick never
 * double-process the same row.
 *
 * `limit` defaults to 1: each report can take ~15-20s, and the tick shares
 * a short serverless budget with the SMS/finance/todo work, so it drains
 * one lead per minute-tick. A long-lived worker (the Netlify background
 * function) can pass a larger batch.
 */
export async function processPendingResearch(
  supabase: DB,
  limit = 1,
): Promise<ResearchTickResult> {
  const result: ResearchTickResult = { processed: 0, failed: 0 };
  if (!isResearchConfigured()) return result;

  const stuckBefore = new Date(Date.now() - STUCK_AFTER_MS).toISOString();

  const { data: rows } = await supabase
    .from("lead_research")
    .select("id, lead_id, company_name, status, updated_at")
    .or(`status.eq.pending,and(status.eq.running,updated_at.lt.${stuckBefore})`)
    .order("updated_at", { ascending: true })
    .limit(Math.max(1, limit));

  if (!rows?.length) return result;

  // `runResearchRow` atomically claims each row, so a row an inline run is
  // already handling is `skipped` here (not a failure). A row only reaches a
  // non-terminal state again if a serverless function died mid-run — the
  // stuck-timeout in the claim then lets exactly one worker retry it.
  for (const row of rows) {
    const outcome = await runResearchRow(supabase, row);
    if (outcome === "done") result.processed += 1;
    else if (outcome === "error") result.failed += 1;
  }

  return result;
}
