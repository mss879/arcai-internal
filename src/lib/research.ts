import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, LeadResearchStatus } from "@/lib/database.types";
import {
  discover,
  analyzeCompetitor,
  auditSite,
  synthesize,
  isResearchConfigured,
  type ResearchInput,
} from "@/lib/ai/lead-research";

type DB = SupabaseClient<Database>;

export type ResearchTickResult = { processed: number; failed: number };

/**
 * A claimed step's lease. Comfortably longer than any single step (each is
 * internally capped well under ~30s by the Firecrawl/OpenAI timeouts), yet
 * short enough that a step abandoned by a killed serverless function is retried
 * on the very next minute-tick instead of stalling for a minute-plus.
 */
const LOCK_TTL_MS = 45 * 1000;

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
          // Reset the pipeline on re-queue so a re-run starts clean.
          analysis: {},
          locked_at: null,
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
 * Queue a report and run its FIRST step immediately (the homepage brand +
 * search discovery), so a new lead shows progress at once. The remaining
 * steps are advanced by the automation tick. If this inline step outlives
 * the serverless budget the row stays claimable and the tick resumes it —
 * a report is never lost. Never throws.
 */
export async function startLeadResearch(
  supabase: DB,
  opts: { leadId: string; company: string; requestedBy?: string | null },
): Promise<{ ok: boolean; id?: string }> {
  const queued = await queueLeadResearch(supabase, opts);
  if (!queued.ok || !queued.id) return queued;
  await drainResearchRow(supabase, queued.id);
  return queued;
}

/**
 * Run a research row through the WHOLE pipeline in one background pass, instead
 * of a single step per minute-tick. Each step is committed and lease-fenced
 * independently, so if this outlives the serverless budget the tick simply
 * resumes from wherever it got to — nothing is lost or double-processed. Stops
 * as soon as a step is `done`, `error`, or `skipped` (another worker has it).
 */
export async function drainResearchRow(
  supabase: DB,
  rowId: string,
  maxSteps = 6,
): Promise<StepOutcome> {
  let outcome: StepOutcome = "skipped";
  for (let i = 0; i < maxSteps; i++) {
    outcome = await advanceResearchRow(supabase, rowId);
    if (outcome !== "advanced") break;
  }
  return outcome;
}

/** Pull the lead fields that sharpen the searches. */
async function researchInputForLead(
  supabase: DB,
  leadId: string,
  fallbackCompany: string,
): Promise<ResearchInput> {
  const { data: lead } = await supabase
    .from("leads")
    .select("company, company_website, contact_name, company_id")
    .eq("id", leadId)
    .maybeSingle();

  let website: string | null = lead?.company_website?.trim() || null;
  let industry: string | null = null;
  let location: string | null = null;
  if (lead?.company_id) {
    const { data: company } = await supabase
      .from("companies")
      .select("website, industry, city")
      .eq("id", lead.company_id)
      .maybeSingle();
    // The lead's own website wins; fall back to the linked organization's.
    website = website || company?.website || null;
    industry = company?.industry ?? null;
    location = company?.city ?? null;
  }

  return {
    company: lead?.company?.trim() || fallbackCompany,
    website,
    industry,
    // Default the geography to Sri Lanka — every lead in this workspace is
    // a Sri Lankan business, which massively disambiguates common names.
    location: location || "Sri Lanka",
    contactName: lead?.contact_name ?? null,
  };
}

/** Outcome of advancing one step. */
export type StepOutcome = "advanced" | "done" | "error" | "skipped";

/** Non-terminal states the pipeline can be claimed in. */
const CLAIMABLE: LeadResearchStatus[] = [
  "pending",
  "running",
  "discovered",
  "analyzed",
  "audited",
];

/**
 * Advance ONE step of a lead_research row's pipeline
 * (pending → discovered → analyzed → audited → done). Atomically claims the row
 * with a short lease (`locked_at`) so the inline run and the tick can never
 * process the same step twice, then runs exactly one step and releases the
 * lease. Returns `skipped` when another worker holds the lease. Never throws.
 */
export async function advanceResearchRow(
  supabase: DB,
  rowId: string,
): Promise<StepOutcome> {
  const lockCutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
  // Compare-and-swap: grab the lease only if the row is claimable and its
  // lease is free or expired. Applied atomically in one statement.
  const { data: claimed } = await supabase
    .from("lead_research")
    .update({ locked_at: new Date().toISOString() })
    .eq("id", rowId)
    .in("status", CLAIMABLE)
    .or(`locked_at.is.null,locked_at.lt.${lockCutoff}`)
    .select("id, lead_id, company_name, status, analysis, locked_at");
  if (!claimed?.length) return "skipped";
  const row = claimed[0];
  // The exact lease value we hold. Every commit is FENCED on it: if our lease
  // expired and another worker (or a re-queue) took the row, our write matches
  // zero rows and no-ops instead of clobbering their state.
  const token = row.locked_at;
  if (!token) return "skipped"; // we just set it; guards the type + a freak null

  // Persist a step result only while we still own the lease; throw on a real
  // DB error so the catch marks the row errored (a fenced-out no-op is fine).
  const commit = async (patch: Record<string, unknown>) => {
    const { error } = await supabase
      .from("lead_research")
      .update({ ...patch, locked_at: null })
      .eq("id", rowId)
      .eq("locked_at", token);
    if (error) throw new Error(error.message);
  };

  try {
    const input = await researchInputForLead(
      supabase,
      row.lead_id,
      row.company_name,
    );

    // pending/running → discover (homepage brand + site map + searches)
    if (row.status === "pending" || row.status === "running") {
      const analysis = await discover(input);
      await commit({
        status: "discovered",
        analysis: analysis as unknown as Record<string, unknown>,
        error: null,
        company_name: input.company,
      });
      return "advanced";
    }

    // discovered → analyze the top competitor + deep-read own pages
    if (row.status === "discovered") {
      const analysis = await analyzeCompetitor(input, row.analysis);
      await commit({
        status: "analyzed",
        analysis: analysis as unknown as Record<string, unknown>,
      });
      return "advanced";
    }

    // analyzed → audit the website (PageSpeed) + domain (RDAP)
    if (row.status === "analyzed") {
      const analysis = await auditSite(input, row.analysis);
      await commit({
        status: "audited",
        analysis: analysis as unknown as Record<string, unknown>,
      });
      return "advanced";
    }

    // audited → synthesize the dossier
    if (row.status === "audited") {
      const { report, sources } = await synthesize(input, row.analysis);
      await commit({
        status: "done",
        report: report as unknown as Record<string, unknown>,
        sources: sources as unknown as Record<string, unknown>[],
        error: null,
      });
      return "done";
    }

    // Unknown/terminal — release the lease (fenced).
    await supabase
      .from("lead_research")
      .update({ locked_at: null })
      .eq("id", rowId)
      .eq("locked_at", token);
    return "skipped";
  } catch (e) {
    console.error("[research] step failed:", e);
    // Fenced: only mark errored if we still hold the lease.
    await supabase
      .from("lead_research")
      .update({
        status: "error",
        error: e instanceof Error ? e.message : "Research failed.",
        locked_at: null,
      })
      .eq("id", rowId)
      .eq("locked_at", token);
    return "error";
  }
}

/**
 * Advance queued research from the automation tick. Each report is a 4-step
 * pipeline (discover → analyze → audit → synthesize); the tick moves each
 * claimable row forward by ONE step (a step can take ~20s and shares the tick's
 * budget with SMS/finance/todo work), so a report completes over a few
 * minute-ticks. `advanceResearchRow`'s lease means a row an inline run already
 * owns is `skipped`, not double-processed.
 *
 * `limit` is the number of rows advanced per tick (one step each).
 */
export async function processPendingResearch(
  supabase: DB,
  limit = 1,
): Promise<ResearchTickResult> {
  const result: ResearchTickResult = { processed: 0, failed: 0 };
  if (!isResearchConfigured()) return result;

  const lockCutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
  const { data: rows } = await supabase
    .from("lead_research")
    .select("id, status, locked_at, updated_at")
    .in("status", CLAIMABLE)
    .or(`locked_at.is.null,locked_at.lt.${lockCutoff}`)
    .order("updated_at", { ascending: true })
    .limit(Math.max(1, limit));

  if (!rows?.length) return result;

  for (const row of rows) {
    const outcome = await advanceResearchRow(supabase, row.id);
    if (outcome === "done" || outcome === "advanced") result.processed += 1;
    else if (outcome === "error") result.failed += 1;
  }

  return result;
}
