import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, LeadResearchStatus } from "@/lib/database.types";
import {
  discover,
  analyzeCompetitor,
  synthesize,
  buildSynthMessages,
  finalizeSynthesis,
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
 * The slow OpenAI synthesis runs in a Netlify Background Function (15-min
 * budget) so a reasoning model can finish no matter how long it thinks. These
 * bound the wait, timed from `analysis.synthStartedAt` (NOT `updated_at`, which
 * the set_updated_at trigger bumps on every claim):
 *   - after STALE with no worker output, nudge the worker again;
 *   - after GIVEUP, stop waiting and emit a basic report with the reason.
 */
// STALE is above the worker's own 12-min OpenAI timeout so a still-running
// worker is never double-fired; a truly-vanished one is re-nudged after it.
const SYNTH_STALE_MS = 14 * 60 * 1000;
const SYNTH_GIVEUP_MS = 22 * 60 * 1000;

/**
 * Fire the Netlify Background Function that performs the OpenAI synthesis for
 * one row. Fire-and-forget: the function returns 202 immediately and writes its
 * result back to the row. Returns false if we couldn't even reach it.
 */
async function triggerSynthWorker(rowId: string): Promise<boolean> {
  const base = (process.env.URL || process.env.NEXT_PUBLIC_APP_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) return false;
  const secret = process.env.SMS_CRON_SECRET?.trim();
  try {
    const res = await fetch(
      `${base}/.netlify/functions/research-synthesize-background`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify({ id: rowId }),
      },
    );
    return res.ok || res.status === 202;
  } catch (e) {
    console.error("[research] could not trigger synth worker:", e);
    return false;
  }
}

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
          // Reset the pipeline on re-queue so a re-run starts clean. `runStartedAt`
          // (epoch ms) anchors the UI's elapsed timer to when THIS run began, so
          // it measures the real duration and survives page refreshes — a re-queue
          // resets it, which is exactly right for a re-run.
          analysis: { runStartedAt: Date.now() },
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
  "audited", // legacy in-flight rows from the old audit step
  "synthesizing",
];

/**
 * Advance ONE step of a lead_research row's pipeline:
 *   pending → discovered → analyzed → done          (local: synth inline)
 *   pending → discovered → analyzed → synthesizing → done  (Netlify: bg worker)
 * Atomically claims the row with a short lease (`locked_at`) so the inline run
 * and the tick can never process the same step twice, then runs exactly one step
 * and releases the lease. Returns `skipped` when another worker holds the lease
 * (or when a `synthesizing` row is still waiting on the worker). Never throws.
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

  // The run-start stamp is set once at queue time; carry it across each step so
  // the UI's elapsed timer stays anchored to the real start (every step below
  // replaces `analysis` wholesale, which would otherwise drop it).
  const runStartedAt = (
    row.analysis as unknown as { runStartedAt?: unknown } | null
  )?.runStartedAt;

  // Persist a step result only while we still own the lease; throw on a real
  // DB error so the catch marks the row errored (a fenced-out no-op is fine).
  const commit = async (patch: Record<string, unknown>) => {
    const merged =
      patch.analysis && typeof patch.analysis === "object" && runStartedAt != null
        ? {
            ...patch,
            analysis: {
              ...(patch.analysis as Record<string, unknown>),
              runStartedAt,
            },
          }
        : patch;
    const { error } = await supabase
      .from("lead_research")
      .update({ ...merged, locked_at: null })
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

    // analyzed (or a legacy 'audited' row) → synthesize the dossier.
    if (row.status === "analyzed" || row.status === "audited") {
      // Local / non-Netlify: no function timeout, so synthesize inline.
      if (!process.env.NETLIFY) {
        const { report, sources } = await synthesize(input, row.analysis);
        await commit({
          status: "done",
          report: report as unknown as Record<string, unknown>,
          sources: sources as unknown as Record<string, unknown>[],
          error: null,
        });
        return "done";
      }
      // Netlify: hand the slow OpenAI call to a 15-min Background Function.
      // Build the prompt here (fast, pure), stash it, and fire the worker.
      const messages = buildSynthMessages(input, row.analysis);
      if (!messages) {
        // Nothing to analyze — finalize a basic report inline (no OpenAI call).
        const { report, sources } = finalizeSynthesis(input, row.analysis, null);
        await commit({
          status: "done",
          report: report as unknown as Record<string, unknown>,
          sources: sources as unknown as Record<string, unknown>[],
          error: null,
        });
        return "done";
      }
      const analysis = {
        ...(row.analysis as Record<string, unknown>),
        synthPrompt: messages.user,
        synthSystem: messages.system,
        synthStartedAt: Date.now(),
        aiRaw: null,
        aiError: null,
      };
      await commit({ status: "synthesizing", analysis });
      await triggerSynthWorker(rowId);
      return "advanced";
    }

    // synthesizing → assemble once the worker has produced output, else wait
    // (timed from synthStartedAt inside analysis, immune to the updated_at bump).
    if (row.status === "synthesizing") {
      const a = (row.analysis ?? {}) as Record<string, unknown>;
      const aiRaw = typeof a.aiRaw === "string" ? a.aiRaw : null;
      const aiError = typeof a.aiError === "string" ? a.aiError : null;
      const startedAt =
        typeof a.synthStartedAt === "number" ? a.synthStartedAt : 0;
      const ageMs = startedAt ? Date.now() - startedAt : Infinity;

      if (aiRaw || aiError) {
        const { report, sources } = finalizeSynthesis(
          input,
          row.analysis,
          aiRaw,
          aiError,
        );
        await commit({
          status: "done",
          report: report as unknown as Record<string, unknown>,
          sources: sources as unknown as Record<string, unknown>[],
          error: null,
        });
        return "done";
      }
      if (ageMs > SYNTH_GIVEUP_MS) {
        const { report, sources } = finalizeSynthesis(
          input,
          row.analysis,
          null,
          "The AI synthesis worker didn't respond in time. Re-run to try again.",
        );
        await commit({
          status: "done",
          report: report as unknown as Record<string, unknown>,
          sources: sources as unknown as Record<string, unknown>[],
          error: null,
        });
        return "done";
      }
      if (ageMs > SYNTH_STALE_MS) {
        // Worker likely died mid-run — reset the clock and nudge it again.
        await commit({
          status: "synthesizing",
          analysis: { ...a, synthStartedAt: Date.now() },
        });
        await triggerSynthWorker(rowId);
        return "advanced";
      }
      // Still thinking — release the lease and let a later tick check back.
      await supabase
        .from("lead_research")
        .update({ locked_at: null })
        .eq("id", rowId)
        .eq("locked_at", token);
      return "skipped";
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
