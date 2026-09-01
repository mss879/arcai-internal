import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, LeadOutreachStatus } from "@/lib/database.types";
import {
  researchSiteAudit,
  isResearchConfigured,
  extractEmails,
} from "@/lib/ai/lead-research";
import { queueLeadResearch } from "@/lib/research";
import { firecrawlScrape, isFirecrawlConfigured } from "@/lib/ai/firecrawl";
import { openaiChatJSON, isOpenAIConfigured } from "@/lib/ai/openai";
import { checkEmail } from "@/lib/email-check";
import { sendGenericEmail } from "@/lib/email";
import { PRICING_CATALOG } from "@/lib/pricing-catalog";
import type { ResearchAudit } from "@/lib/research-report";

/** ARC AI's contact block — appended to EVERY outreach pitch (see coldFooter). */
const OUTREACH_CONTACT = {
  name: "ARC AI",
  website: "www.arcai.agency",
  websiteUrl: "https://www.arcai.agency",
  phones: [
    { label: "UK", number: "+44 7466 368427" },
    { label: "Sri Lanka", number: "+94 77 185 2522" },
  ],
  address: "91 Daisy Villa Avenue, Colombo 4, Sri Lanka",
};

type DB = SupabaseClient<Database>;
type OutreachRow = Database["public"]["Tables"]["lead_outreach"]["Row"];
type LeadRow = Database["public"]["Tables"]["leads"]["Row"];

export type OutreachTickResult = { processed: number; failed: number };

/**
 * The copywriter. This defaulted to `undefined` — which quietly fell through to
 * AI_MODELS.chat (gpt-4o-mini) — while the sibling prospecting drafter defaulted
 * to gpt-5.4-mini, so outreach was being written by the weaker model by accident.
 * Pinned explicitly: this copy goes out under the agency's name, sometimes with
 * no human reading it first.
 */
const MODEL =
  process.env.OPENAI_OUTREACH_MODEL ||
  process.env.OPENAI_PROSPECTING_MODEL ||
  "gpt-5.4-mini";
/**
 * Kept at "medium": the drafting step runs inside the automation tick, which
 * has a ~30s serverless budget on Netlify. "high" writes marginally better copy
 * but routinely blows that budget, and a step killed mid-flight just retries
 * next tick — burning spend for a draft that never lands. Override per-env.
 */
const REASONING_EFFORT = process.env.OPENAI_OUTREACH_REASONING_EFFORT || "medium";
/**
 * A compose measured 7-18s on gpt-5.4-mini/medium. This ceiling lets the slow
 * tail through but still fails cleanly into the deterministic template rather
 * than being killed mid-write by the serverless timeout.
 */
const COMPOSE_TIMEOUT_MS = Number(
  process.env.OPENAI_OUTREACH_TIMEOUT_MS || 18_000,
);
/**
 * Wall-clock budget for one outreach pass. `/api/automation/tick` runs ~15
 * processors inside Netlify's ~26s function budget, so outreach cannot simply
 * take MAX_PER_TICK × compose-time — three slow drafts would blow the whole
 * tick and take every other automation down with it.
 *
 * The budget self-tunes: the cheap steps (queue research, poll research) cost
 * milliseconds and fly through, while a slow draft consumes the budget and
 * ends the pass. In practice ~1 draft/tick = ~1,440/day, far above any daily
 * send cap, so this costs no real throughput.
 */
const TICK_BUDGET_MS = Number(process.env.OUTREACH_TICK_BUDGET_MS || 12_000);
/** How many draft pipelines to advance per minute-tick (bounds cost + reputation). */
const MAX_PER_TICK = 3;
/** Max scraped emails to actually message per lead. */
const MAX_RECIPIENTS = 5;
/**
 * Auto-send campaigns message ONE address per lead — the best-ranked one.
 * Hitting info@ + sales@ + admin@ at the same company in the same minute is a
 * textbook spam signal, and it would burn the daily cap 5× faster for no extra
 * reach. The manual Approve & send path still uses the full list.
 */
const CAMPAIGN_MAX_RECIPIENTS = 1;
/** Lease TTL — mirror research.ts; each step is internally timeout-capped well under this. */
const LOCK_TTL_MS = 45 * 1000;
/** Consecutive claims without committed progress before the draft is parked
 * as `failed` — the breaker for a platform kill mid-step, which never
 * reaches the catch and would otherwise repeat the same paid step on every
 * tick. Bumped at claim time, reset by every commit and healthy release.
 * See research.ts. */
const MAX_CLAIMS = 5;
/**
 * How long the `researching` step waits for the full dossier before giving up
 * and drafting from the site audit alone. Research is a 3-step pipeline driven
 * by its own minute-tick (~2-3 min typical), so this is generous; a lead is
 * never stuck behind research that died.
 */
const RESEARCH_WAIT_MS = 12 * 60 * 1000;
/** Auto-sends to attempt per tick. The daily cap is the real bound; this just paces bursts. */
const MAX_SEND_PER_TICK = 2;
/** Non-terminal states the draft pipeline can be claimed in (pending → researching → drafting → ready). */
const CLAIMABLE: LeadOutreachStatus[] = ["pending", "researching", "drafting"];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function isEmailOutreachConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY) && isResearchConfigured();
}

/** Global outreach settings from the generic app_settings key/value store. */
export async function outreachSettings(
  supabase: DB,
): Promise<{ enabled: boolean; fromEmail: string }> {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "outreach")
    .maybeSingle();
  const v = (data?.value ?? {}) as Record<string, unknown>;
  return {
    // Auto-drafting new finds is on by default.
    enabled: v.enabled !== false,
    fromEmail:
      typeof v.from_email === "string" && v.from_email.trim()
        ? v.from_email.trim()
        : "support@arcai.agency",
  };
}

// ---------------------------------------------------------------------------
// Enqueue + recipients
// ---------------------------------------------------------------------------

/**
 * Queue an outreach draft for a lead. Insert-only with `on conflict (lead_id)
 * do nothing` — the unique constraint guarantees a lead is never queued (or
 * emailed) twice, so a re-import or an overlapping tick is a harmless no-op.
 * Never throws (fire-and-forget from the import path).
 */
export async function enqueueLeadOutreach(
  supabase: DB,
  opts: {
    leadId: string;
    recipients?: string[];
    source?: "prospecting" | "manual";
    requestedBy?: string | null;
  },
): Promise<{ ok: boolean; id?: string }> {
  try {
    const { data, error } = await supabase
      .from("lead_outreach")
      .upsert(
        {
          lead_id: opts.leadId,
          recipients: cleanEmails(opts.recipients ?? [], ""),
          source: opts.source ?? "prospecting",
          ...(opts.requestedBy ? { requested_by: opts.requestedBy } : {}),
        },
        { onConflict: "lead_id", ignoreDuplicates: true },
      )
      .select("id")
      .maybeSingle();
    if (error) {
      console.error("[outreach] enqueue failed:", error.message);
      return { ok: false };
    }
    return { ok: true, id: data?.id };
  } catch (e) {
    console.error("[outreach] enqueue threw:", e);
    return { ok: false };
  }
}

/**
 * Resolve the full send list for a lead, best source first:
 *   1. the outreach row's stored recipients,
 *   2. `leads.custom.prospect_emails` (the array Find Leads scraped),
 *   3. `leads.contact_email` (manually-added leads),
 *   4. last resort — re-scrape the homepage.
 * Deduped, junk-stripped, capped.
 */
export async function buildRecipients(
  supabase: DB,
  leadId: string,
): Promise<string[]> {
  const { data: lead } = await supabase
    .from("leads")
    .select("contact_email, company_website, custom")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return [];

  const custom = (lead.custom ?? {}) as Record<string, unknown>;
  const stored = Array.isArray(custom.prospect_emails)
    ? (custom.prospect_emails as unknown[]).map((e) => String(e))
    : [];
  const domain = domainOf(lead.company_website);

  let emails = cleanEmails(
    [...stored, ...(lead.contact_email ? [lead.contact_email] : [])],
    domain,
  );
  if (emails.length) return emails;

  // Nothing stored — try one homepage scrape before giving up.
  if (lead.company_website && isFirecrawlConfigured()) {
    try {
      const page = await firecrawlScrape(lead.company_website, { html: true });
      if (page) {
        emails = cleanEmails(
          extractEmails(page.html || page.markdown),
          domain,
        );
      }
    } catch (e) {
      console.error("[outreach] recipient re-scrape failed:", e);
    }
  }
  return emails;
}

// ---------------------------------------------------------------------------
// Draft pipeline (pending → drafting → ready). NEVER sends.
// ---------------------------------------------------------------------------

/**
 * "waiting" = the row is parked on something out of our hands (the research
 * dossier). It's not progress and not a failure — the lease is released and
 * the next tick re-checks, so a drain stops instead of spinning on it.
 */
export type StepOutcome =
  | "advanced"
  | "done"
  | "error"
  | "skipped"
  | "waiting";

/** Run a row through the draft pipeline in one pass (manual/inline path). */
export async function drainOutreachRow(
  supabase: DB,
  rowId: string,
  maxSteps = 4,
): Promise<StepOutcome> {
  let outcome: StepOutcome = "skipped";
  for (let i = 0; i < maxSteps; i++) {
    outcome = await advanceOutreachRow(supabase, rowId);
    if (outcome !== "advanced") break;
  }
  return outcome;
}

/**
 * Advance ONE step of a draft pipeline, lease-fenced exactly like
 * advanceResearchRow: CAS-claim the row, run one step, release the lease.
 * Stops (returns "done") once the draft is `ready` — it never sends.
 */
export async function advanceOutreachRow(
  supabase: DB,
  rowId: string,
): Promise<StepOutcome> {
  const lockCutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
  const { data: claimed } = await supabase
    .from("lead_outreach")
    .update({ locked_at: new Date().toISOString() })
    .eq("id", rowId)
    .in("status", CLAIMABLE)
    .or(`locked_at.is.null,locked_at.lt.${lockCutoff}`)
    .select("*");
  if (!claimed?.length) return "skipped";
  const row = claimed[0] as OutreachRow;
  const token = row.locked_at;
  if (!token) return "skipped";

  // Kill-loop breaker — see MAX_CLAIMS.
  const priorClaims = row.claims ?? 0;
  if (priorClaims >= MAX_CLAIMS) {
    await supabase
      .from("lead_outreach")
      .update({
        status: "failed",
        error:
          "Gave up after repeated interrupted attempts — re-queue to try again.",
        locked_at: null,
      })
      .eq("id", rowId)
      .eq("locked_at", token);
    return "error";
  }
  await supabase
    .from("lead_outreach")
    .update({ claims: priorClaims + 1 })
    .eq("id", rowId)
    .eq("locked_at", token);

  const commit = async (patch: Record<string, unknown>) => {
    const { error } = await supabase
      .from("lead_outreach")
      // Progress committed → the claim counter starts over.
      .update({ ...patch, locked_at: null, claims: 0 })
      .eq("id", rowId)
      .eq("locked_at", token);
    if (error) throw new Error(error.message);
  };

  try {
    const { data: lead } = await supabase
      .from("leads")
      .select("*")
      .eq("id", row.lead_id)
      .maybeSingle();
    if (!lead) {
      await commit({ status: "failed", error: "Lead no longer exists." });
      return "error";
    }

    // pending → kick off the full company dossier, then wait for it.
    // Reuses a finished report as-is (zero extra spend); only queues a fresh
    // run when there's nothing usable yet.
    if (row.status === "pending") {
      const existing = await finishedResearch(supabase, row.lead_id);
      if (existing) {
        const { audit, facts } = await gatherContext(
          supabase,
          lead as LeadRow,
          existing,
        );
        await commit({
          status: "drafting",
          audit: (audit ?? null) as unknown as Record<string, unknown> | null,
          audit_score: audit?.overall ?? null,
          company_facts: facts as unknown as Record<string, unknown>,
          error: null,
        });
        return "advanced";
      }

      const company =
        lead.company?.trim() || lead.title?.trim() || "";
      // No company name = nothing to research on. Draft from the audit alone.
      if (!company) {
        const { audit, facts } = await gatherContext(supabase, lead as LeadRow, null);
        await commit({
          status: "drafting",
          audit: (audit ?? null) as unknown as Record<string, unknown> | null,
          audit_score: audit?.overall ?? null,
          company_facts: facts as unknown as Record<string, unknown>,
          error: null,
        });
        return "advanced";
      }

      await queueLeadResearch(supabase, {
        leadId: row.lead_id,
        company,
        requestedBy: row.requested_by,
      });
      await commit({
        status: "researching",
        research_started_at: new Date().toISOString(),
        error: null,
      });
      return "advanced";
    }

    // researching → poll the dossier. Research has its own tick/drain driving
    // it; we just wait for a verdict (or time out into an audit-only draft).
    if (row.status === "researching") {
      const done = await finishedResearch(supabase, row.lead_id);
      const startedAt = row.research_started_at
        ? new Date(row.research_started_at).getTime()
        : 0;
      const timedOut =
        !startedAt || Date.now() - startedAt > RESEARCH_WAIT_MS;

      if (!done && !timedOut) {
        // Still cooking. Drop the lease so the next tick re-checks; this is
        // NOT progress, so drainOutreachRow stops here rather than spinning.
        // It IS a healthy wait though, so the claim counter resets — only
        // claims that end in a kill should accumulate.
        await supabase
          .from("lead_outreach")
          .update({ locked_at: null, claims: 0 })
          .eq("id", rowId)
          .eq("locked_at", token);
        return "waiting";
      }

      const { audit, facts } = await gatherContext(
        supabase,
        lead as LeadRow,
        done,
      );
      await commit({
        status: "drafting",
        audit: (audit ?? null) as unknown as Record<string, unknown> | null,
        audit_score: audit?.overall ?? null,
        company_facts: facts as unknown as Record<string, unknown>,
        error: null,
      });
      return "advanced";
    }

    // drafting → compose the email (never throws — template fallback)
    if (row.status === "drafting") {
      const audit = (row.audit ?? null) as ResearchAudit | null;
      const facts = (row.company_facts ?? {}) as Record<string, unknown>;
      const { subject, body } = await composeOutreachEmail(
        lead as LeadRow,
        audit,
        facts,
      );
      await commit({ status: "ready", subject, body, error: null });
      // Auto-send rows aren't waiting on anyone — don't nag the board with a
      // "Draft Ready" chip they're not meant to act on. processAutoSendQueue
      // picks them up from `ready` on the next tick, under the daily cap.
      if (!row.auto_send) {
        await setLeadTags(supabase, row.lead_id, ["Draft Ready"]);
      }
      return "done";
    }

    // Unknown/terminal — release the lease (fenced).
    await supabase
      .from("lead_outreach")
      .update({ locked_at: null })
      .eq("id", rowId)
      .eq("locked_at", token);
    return "skipped";
  } catch (e) {
    console.error("[outreach] draft step failed:", e);
    await supabase
      .from("lead_outreach")
      .update({
        status: "failed",
        error: e instanceof Error ? e.message : "Draft failed.",
        attempts: row.attempts + 1,
        locked_at: null,
      })
      .eq("id", rowId)
      .eq("locked_at", token);
    return "error";
  }
}

/** Advance queued outreach drafts from the automation tick (one step each). */
export async function processDueOutreach(
  supabase: DB,
): Promise<OutreachTickResult> {
  const result: OutreachTickResult = { processed: 0, failed: 0 };
  if (!isResearchConfigured()) return result;

  const lockCutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
  // Over-fetch, then drop rows owned by a paused/cancelled campaign in JS.
  // Pausing has to stop the *drafting* spend too, not just the sending — and
  // one clear filter beats stacking PostgREST .or() groups on a null FK.
  const { data: rows } = await supabase
    .from("lead_outreach")
    .select("id, campaign_id")
    .in("status", CLAIMABLE)
    .or(`locked_at.is.null,locked_at.lt.${lockCutoff}`)
    .order("updated_at", { ascending: true })
    .limit(MAX_PER_TICK * 6);
  if (!rows?.length) return result;

  const halted = await haltedCampaignIds(supabase);
  const due = rows
    .filter((r) => !r.campaign_id || !halted.has(r.campaign_id))
    .slice(0, MAX_PER_TICK);

  const deadline = Date.now() + TICK_BUDGET_MS;
  for (const row of due) {
    // Anything left is picked up by the next tick — rows stay claimable, so
    // stopping early loses nothing but protects the rest of the tick.
    if (Date.now() > deadline) break;
    const outcome = await advanceOutreachRow(supabase, row.id);
    if (outcome === "done" || outcome === "advanced") result.processed += 1;
    else if (outcome === "error") result.failed += 1;
  }
  return result;
}

/** Campaigns whose work must stop: paused by the owner, or cancelled outright. */
async function haltedCampaignIds(supabase: DB): Promise<Set<string>> {
  const { data } = await supabase
    .from("outreach_campaigns")
    .select("id")
    .in("status", ["paused", "cancelled"]);
  return new Set((data ?? []).map((c) => c.id));
}

// ---------------------------------------------------------------------------
// Auto-send queue — the no-approval leg. THIS is the only code path that can
// email a prospect without a human clicking anything, so every guard lives here.
// ---------------------------------------------------------------------------

export type AutoSendTickResult = {
  sent: number;
  failed: number;
  /** Set when the queue was held back rather than empty — surfaced in the UI. */
  capped?: boolean;
};

/** Emails sent by ANY path since local midnight — what the daily cap counts. */
export async function sentToday(supabase: DB): Promise<number> {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const { count } = await supabase
    .from("lead_outreach")
    .select("id", { count: "exact", head: true })
    .gte("sent_at", since.toISOString());
  return count ?? 0;
}

/**
 * Send drafted auto-send rows belonging to RUNNING campaigns, oldest first,
 * bounded by the smallest daily cap in play. Pausing a campaign stops it here
 * within a minute — the drafts survive, they just stop going out.
 *
 * Deliberately does NOT run when outreach is globally disabled.
 */
export async function processAutoSendQueue(
  supabase: DB,
): Promise<AutoSendTickResult> {
  const result: AutoSendTickResult = { sent: 0, failed: 0 };

  // Reconcile completion first, and unconditionally — a draft-only campaign
  // never reaches the send code below but still needs to be marked done.
  await closeFinishedCampaigns(supabase);

  if (!isEmailOutreachConfigured()) return result;

  const { enabled } = await outreachSettings(supabase);
  if (!enabled) return result;

  const { data: campaigns } = await supabase
    .from("outreach_campaigns")
    .select("id, daily_cap")
    .eq("status", "running")
    .eq("auto_send", true);
  if (!campaigns?.length) return result;

  // One shared mailbox, one shared reputation — the strictest cap wins.
  const cap = Math.min(...campaigns.map((c) => c.daily_cap));
  const remaining = cap - (await sentToday(supabase));
  if (remaining <= 0) {
    result.capped = true;
    return result;
  }

  const { data: rows } = await supabase
    .from("lead_outreach")
    .select("lead_id")
    .eq("status", "ready")
    .eq("auto_send", true)
    .in(
      "campaign_id",
      campaigns.map((c) => c.id),
    )
    .order("updated_at", { ascending: true })
    .limit(Math.min(MAX_SEND_PER_TICK, remaining));
  if (!rows?.length) return result;

  for (const row of rows) {
    const res = await sendLeadOutreach(supabase, row.lead_id, {
      maxRecipients: CAMPAIGN_MAX_RECIPIENTS,
    });
    if (res.ok) result.sent += 1;
    else if (!res.skipped) result.failed += 1;
  }
  await closeFinishedCampaigns(supabase);
  return result;
}

/** Flip a running campaign to `done` once none of its rows are still in flight. */
async function closeFinishedCampaigns(supabase: DB): Promise<void> {
  const { data: campaigns } = await supabase
    .from("outreach_campaigns")
    .select("id, auto_send")
    .eq("status", "running");
  if (!campaigns?.length) return;

  for (const c of campaigns) {
    // An auto-send run isn't finished until the mail is actually out. A
    // draft-only run is finished once everything is DRAFTED — its rows then
    // sit at `ready` indefinitely, waiting on a human, which is the point.
    const inFlight: LeadOutreachStatus[] = c.auto_send
      ? ["pending", "researching", "drafting", "ready", "sending"]
      : ["pending", "researching", "drafting"];
    const { count } = await supabase
      .from("lead_outreach")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", c.id)
      .in("status", inFlight);
    if ((count ?? 0) === 0) {
      await supabase
        .from("outreach_campaigns")
        .update({ status: "done", finished_at: new Date().toISOString() })
        .eq("id", c.id)
        .eq("status", "running");
    }
  }
}

/** The finished dossier for a lead, or null if there isn't a usable one yet. */
async function finishedResearch(
  supabase: DB,
  leadId: string,
): Promise<Record<string, unknown> | null> {
  const { data } = await supabase
    .from("lead_research")
    .select("report, status")
    .eq("lead_id", leadId)
    .maybeSingle();
  if (data?.status !== "done") return null;
  const report = (data.report ?? {}) as Record<string, unknown>;
  return Object.keys(report).length ? report : null;
}

/**
 * Distil a dossier into the personalization facts — gated on whether research
 * is actually sure it profiled the RIGHT company.
 *
 * `match_confidence` is only "high" when the anchor domain's own content names
 * the company (see resolveConfidence in lead-research.ts). Anything less means
 * the dossier may describe a same-named business somewhere else entirely.
 *
 * When it isn't high, the facts are DROPPED rather than passed along with a
 * warning. Warning the model does not work — tested against a low-confidence
 * dossier it cheerfully opened "Hi Karen, your freight brokerage…" to a
 * Sri Lankan lead. On auto-send there's no human to catch that, so the only
 * safe design is that the wrong facts never enter the prompt at all.
 *
 * The audit is deliberately NOT gated: it measured the website on the lead
 * record, so it's true about this prospect no matter who the dossier described.
 *
 * Pure + exported so the trust gate is directly testable without a database.
 */
export function factsFromReport(
  report: Record<string, unknown> | null,
): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  if (!report) return facts;

  const confidence = str(report.match_confidence);
  const trusted = confidence === "high";
  facts.source = "research";
  facts.match_confidence = confidence;
  facts.trusted = trusted;
  if (!trusted) return facts;

  facts.overview = str(report.overview);
  facts.industry = str(report.industry);
  facts.headquarters = str(report.headquarters);
  facts.products_services = strList(report.products_services).slice(0, 12);
  facts.pain_points = strList(report.pain_points).slice(0, 6);
  facts.competitor_gaps = strList(report.competitor_gaps).slice(0, 5);
  facts.talking_points = strList(report.talking_points).slice(0, 5);
  facts.competitors = Array.isArray(report.competitors)
    ? (report.competitors as Record<string, unknown>[])
        .map((c) => str(c?.name))
        .filter(Boolean)
        .slice(0, 5)
    : [];
  facts.key_people = Array.isArray(report.key_people)
    ? (report.key_people as Record<string, unknown>[])
        .map((p) => [str(p?.name), str(p?.title)].filter(Boolean).join(" — "))
        .filter(Boolean)
        .slice(0, 3)
    : [];
  const rep = report.reputation as Record<string, unknown> | null;
  if (rep) {
    facts.reputation = [str(rep.rating), str(rep.summary)]
      .filter(Boolean)
      .join(" — ")
      .slice(0, 300);
  }
  const web = report.web_presence as Record<string, unknown> | null;
  if (web) facts.web_presence = str(web.notes).slice(0, 400);
  return facts;
}

/**
 * Gather everything the writer needs to sound like it actually knows this
 * business: the dossier (what they do, who they are, how competitors are
 * beating them, their reputation) plus a website scorecard.
 *
 * The audit is the pitch's hard evidence, so it's worth a standalone run when
 * the dossier doesn't carry one — but only once, and only if there's a site.
 */
async function gatherContext(
  supabase: DB,
  lead: LeadRow,
  report: Record<string, unknown> | null,
): Promise<{ audit: ResearchAudit | null; facts: Record<string, unknown> }> {
  const website = lead.company_website?.trim() || "";
  const facts = factsFromReport(report);

  // The dossier's own audit is free — take it.
  const fromReport = (report?.audit ?? null) as ResearchAudit | null;
  if (fromReport) {
    facts.audit_source = "research";
    return { audit: fromReport, facts };
  }

  if (!website) {
    facts.no_website = true;
    return { audit: null, facts };
  }

  const result = await researchSiteAudit(website);
  facts.audit_source = "audit";
  facts.measured_url = result?.audit?.measured_url ?? website;
  return { audit: result?.audit ?? null, facts };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : [];
}

/**
 * ARC AI's real service menu, derived from the pricing catalog so it can never
 * drift from what the team actually sells. Names + taglines + headline features,
 * deliberately WITHOUT prices: a cold email that opens with a price list reads
 * like a flyer, and the CTA is a free breakdown — real numbers come later, from
 * the real pricing page. Add-on-only cards (no feature list) are skipped.
 *
 * Exported for testing — it's what the model is told ARC AI can sell, so it's
 * worth being able to inspect it directly.
 */
export function serviceMenu(): string {
  return PRICING_CATALOG.map((group) => {
    const lines = group.packages
      .filter((p) => p.features?.length)
      .map((p) => {
        const head = [p.name, p.tagline].filter(Boolean).join(" — ");
        const top = (p.features ?? []).slice(0, 3).join("; ");
        return `  - ${head}: ${top}`;
      })
      .join("\n");
    return lines ? `${group.title}\n${lines}` : "";
  })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Write the customized cold email. Everything the dossier learned about the
 * business goes in, so the model can lead with something true and specific and
 * then pitch only the services that genuinely fit. A deterministic template is
 * the fallback so a row is NEVER left draftless.
 *
 * Exported for testing — this is the whole product, so it's worth being able
 * to generate a sample against a real dossier without a live campaign.
 */
export async function composeOutreachEmail(
  lead: LeadRow,
  audit: ResearchAudit | null,
  facts: Record<string, unknown>,
): Promise<{ subject: string; body: string }> {
  const business = lead.company?.trim() || lead.title?.trim() || "your business";
  const noWebsite = facts.no_website === true || !lead.company_website?.trim();

  if (isOpenAIConfigured()) {
    try {
      const list = (label: string, v: unknown, max = 6): string => {
        const items = strList(v).slice(0, max);
        return items.length ? `${label}:\n${items.map((i) => `- ${i}`).join("\n")}` : "";
      };
      const context = [
        `business: ${business}`,
        lead.contact_name ? `owner/contact: ${lead.contact_name}` : "",
        lead.company_website
          ? `website: ${lead.company_website}`
          : "situation: has NO website",
        str(facts.industry) ? `industry: ${str(facts.industry)}` : "",
        str(facts.headquarters) ? `location: ${str(facts.headquarters)}` : "",
        str(facts.overview) ? `about them: ${str(facts.overview).slice(0, 900)}` : "",
        list("what they sell", facts.products_services, 12),
        list("decision-makers", facts.key_people, 3),
        str(facts.reputation) ? `reputation: ${str(facts.reputation)}` : "",
        str(facts.web_presence)
          ? `their web presence: ${str(facts.web_presence)}`
          : "",
        list("how competitors are beating them", facts.competitor_gaps, 5),
        list("likely pain points", facts.pain_points, 6),
        audit
          ? `website score: ${audit.overall}/100 (${audit.measured})`
          : "",
        audit?.issues?.length
          ? `concrete website issues:\n${audit.issues
              .slice(0, 6)
              .map((i) => `- ${i}`)
              .join("\n")}`
          : "",
        lead.notes ? `internal notes: ${lead.notes.slice(0, 400)}` : "",
        // Belt-and-braces. factsFromReport has already withheld the untrusted
        // dossier, so there is nothing here to leak — this just stops the model
        // INVENTING an industry to fill the silence.
        facts.trusted === false
          ? `NOTE: nothing is known about this business beyond its name and the website measurements above. Do NOT guess or state their industry, services, size, location, staff or customers. Build the whole email on the website findings alone.`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

      const raw = await openaiChatJSON(
        [
          {
            role: "system",
            content: `You are a senior cold-email copywriter for ARC AI, an AI & digital agency in Sri Lanka. Write ONE outreach email to the business described by the user. Return JSON only: {"subject": "...", "body": "..."}.

WHAT ARC AI ACTUALLY SELLS (never offer anything outside this list):
${serviceMenu()}

The combination that sets ARC AI apart: we build the website AND wire an AI agent into the back of it — a WhatsApp AI sales agent (and/or an on-site chat agent) that answers, qualifies, follows up and books customers 24/7, in English, Sinhala and Tamil, feeding straight into a lead dashboard/CRM. Most agencies hand over a brochure site and walk away; ARC AI ships the thing that actually answers the customer at 11pm.

"subject": under 55 chars. Write it like one person emailing one business about a specific thing — the way you'd title a note to a colleague. Lowercase-ish and plain beats Title Case And Punchy.
- BANNED shapes: "Unlock", "Boost", "Transform", "Elevate", "Supercharge", "Revolutionize", "Improve X with Y", "Grow your X", colon-then-benefit, emoji, exclamation marks, and the company's own name jammed in just to look personalized.
- Bad: "Unlock 24/7 Bookings for Kandy Auto Care". "Improve Your Spice Export Efficiency with AI".
- Derive it from the ONE concrete detail you opened the body with, so it could only have been written to this business. Vary the construction every time — a noun phrase ("your contact form on mobile"), a question ("enquiries going unanswered?"), or a plain observation ("the Matale site loads slowly on phones") are all fair. Do NOT reach for a stock opener like "quick note about…" or "a thought on…"; a run of near-identical subject lines across many emails is itself a spam signal.

"body": plain text, 130-190 words, in this shape:
1. Greet the decision-maker by first name if one is given, else "Hi ${business} team".
2. Open with ONE specific, TRUE observation about them — a real website issue from the list, a gap a competitor is exploiting, or (if they have no website) what that costs them locally. This must read as though you looked at their business, because you did. Never flatter, never open with "I hope this finds you well".
3. One line on what it's plainly costing them. Concrete, no hype, no invented statistics.
4. Pitch the 2-3 services from the list above that genuinely fit THIS business, each tied to their actual situation — not a generic list. If they sell things people ask questions about before buying, the website + WhatsApp AI agent combo is usually the strongest angle. Refer to a package the way a person would in conversation ("a Growth site", "our WhatsApp AI agent"); never paste the catalog's internal formatting or taglines verbatim — "Starter — Get Online Fast" and "Growth — Capture & Close Leads" are how the price list reads, not how an email reads.
5. ONE short line signalling the wider menu (e.g. that ARC AI also handles e-commerce, social media, SEO and business automation) so they know the full range — keep it to a single sentence, do not enumerate everything.
6. Soft CTA: offer a free, no-obligation breakdown of exactly what you'd improve, and ask for a quick reply or call. No pressure, no deadline, no fake scarcity.
7. Sign off exactly "Best regards,\\nThe ARC AI Team".

HARD RULES:
- NEVER invent facts, prices, timelines, statistics, results, client names or case studies. If you don't know a number, don't use one.
- Never mention prices at all — the CTA is the free breakdown.
- Never say you "researched", "scanned", "audited" or "ran a report on" them. Just know things.
- Write like a sharp human wrote it for this one company. No corporate filler, no buzzwords, no em-dash-heavy AI cadence, no "In today's digital landscape".
- Plain text only. No markdown, no bullet characters, no links.
- Do NOT write any website, phone number, address, or contact block — ARC AI's signature (website, phones, office address) and an unsubscribe link are appended automatically.`,
          },
          { role: "user", content: context },
        ],
        {
          model: MODEL,
          reasoningEffort: REASONING_EFFORT,
          timeoutMs: COMPOSE_TIMEOUT_MS,
        },
      );
      const parsed = JSON.parse(raw) as { subject?: string; body?: string };
      const subject = String(parsed.subject ?? "").trim().slice(0, 120);
      const body = String(parsed.body ?? "").trim().slice(0, 2600);
      if (body) {
        return {
          subject: subject || templateOutreach(business, audit, noWebsite).subject,
          body,
        };
      }
    } catch (e) {
      console.error("[outreach] compose failed, using template:", e);
    }
  }
  return templateOutreach(business, audit, noWebsite);
}

/**
 * Deterministic fallback so a draft is never empty — and, since auto-send
 * campaigns can go out on this path if OpenAI is down, it carries the same
 * core pitch (site + WhatsApp AI agent + the wider menu) as the AI version.
 * Less personal by necessity; never wrong.
 */
function templateOutreach(
  business: string,
  audit: ResearchAudit | null,
  noWebsite: boolean,
): { subject: string; body: string } {
  const menu = `We also handle e-commerce stores, social media, SEO and business automation.`;
  const agent = `We can also wire a WhatsApp AI sales agent into the back of it — it answers questions, qualifies buyers and follows up 24/7 in English, Sinhala and Tamil, so enquiries stop going cold overnight.`;
  if (noWebsite) {
    return {
      subject: `A website for ${business}?`,
      body: `Hi ${business} team,\n\nI came across ${business} online and noticed you don't have a website yet — which means customers searching for what you do are landing on competitors instead.\n\nWe're ARC AI, an AI and digital agency. We build fast, modern sites that turn those searches into enquiries. ${agent}\n\n${menu}\n\nHappy to put together a free, no-obligation breakdown of what we'd build and what it would bring in — no pressure either way. Worth a quick chat? Just reply here.\n\nBest regards,\nThe ARC AI Team`,
    };
  }
  return {
    subject: `A few quick wins for ${business}`,
    body: `Hi ${business} team,\n\nI took a look at your website${
      audit?.issues?.[0] ? ` and noticed ${lowerFirst(audit.issues[0])}` : ""
    }. Small things like that quietly cost you enquiries every week.\n\nWe're ARC AI, an AI and digital agency. We'd rebuild it to load fast and actually convert. ${agent}\n\n${menu}\n\nI'd be glad to send a free, no-obligation breakdown of exactly what we'd improve — no pressure either way. Would that be useful? Just reply and I'll put it together.\n\nBest regards,\nThe ARC AI Team`,
  };
}

// ---------------------------------------------------------------------------
// Send (the Approve action's core) — validate → send → tag → log
// ---------------------------------------------------------------------------

/**
 * Approve + send a ready draft. Claims the row (ready|failed → sending) so a
 * double-click or overlapping call can't double-send, validates every recipient
 * against the suppression list + MX/junk, sends each individually (own
 * unsubscribe token), tags the lead "Email Sent" and stores the exact copy.
 */
export async function sendLeadOutreach(
  supabase: DB,
  leadId: string,
  opts?: {
    actorId?: string | null;
    /** Cap the send list (campaigns pin this to 1 — see CAMPAIGN_MAX_RECIPIENTS). */
    maxRecipients?: number;
  },
): Promise<{ ok: boolean; sent?: number; skipped?: boolean; error?: string }> {
  const { data: claimed } = await supabase
    .from("lead_outreach")
    .update({ status: "sending", error: null })
    .eq("lead_id", leadId)
    .in("status", ["ready", "failed"])
    .select("*");
  if (!claimed?.length)
    return { ok: false, error: "This draft isn't ready to send yet." };
  const row = claimed[0] as OutreachRow;

  try {
    const { fromEmail } = await outreachSettings(supabase);
    const { data: lead } = await supabase
      .from("leads")
      .select("company, title")
      .eq("id", leadId)
      .maybeSingle();
    const business = lead?.company?.trim() || lead?.title?.trim() || "your business";

    let recipients = row.recipients?.length
      ? row.recipients
      : await buildRecipients(supabase, leadId);
    recipients = await dropSuppressed(supabase, recipients);
    const checks = await Promise.all(
      recipients.map(async (e) => ({ e, ok: (await checkEmail(e)).ok })),
    );
    // `recipients` is already ranked best-first by cleanEmails, so capping
    // here keeps the single best address rather than an arbitrary one.
    const valid = checks
      .filter((c) => c.ok)
      .map((c) => c.e)
      .slice(0, opts?.maxRecipients ?? MAX_RECIPIENTS);

    if (!valid.length) {
      await supabase
        .from("lead_outreach")
        .update({ status: "skipped", sent_to: [], error: "No deliverable email address." })
        .eq("id", row.id);
      await setLeadTags(supabase, leadId, ["No Email"], ["Draft Ready"]);
      await supabase.from("crm_tasks").insert({
        lead_id: leadId,
        title: `Find an email for ${business}`,
        notes: `Outreach is drafted but no deliverable email was found for this lead. Find a contact address, add it, then re-run outreach.`,
        created_by: opts?.actorId ?? null,
      });
      return { ok: false, skipped: true, error: "No deliverable email found." };
    }

    const subject = row.subject || `A quick idea for ${business}`;
    const sent: string[] = [];
    const messageIds: string[] = [];
    let firstError = "";
    for (const email of valid) {
      const res = await sendGenericEmail({
        to: email,
        subject,
        body: row.body,
        from: fromEmail,
        replyTo: fromEmail,
        footer: coldFooter(email),
      });
      if (res.sent) {
        sent.push(email);
        if (res.id) messageIds.push(res.id);
      } else if (!firstError) {
        firstError = res.error ?? "send failed";
      }
    }

    if (!sent.length) {
      await supabase
        .from("lead_outreach")
        .update({
          status: "failed",
          error: firstError || "Every send failed.",
          attempts: row.attempts + 1,
        })
        .eq("id", row.id);
      return { ok: false, error: firstError || "Every send failed." };
    }

    const now = new Date().toISOString();
    await setLeadTags(supabase, leadId, ["Email Sent"], ["Draft Ready", "No Email"]);
    await supabase.from("lead_activities").insert({
      lead_id: leadId,
      kind: "email",
      title: `AI outreach sent: ${subject}`,
      body: row.body,
      meta: {
        recipients: sent,
        from: fromEmail,
        subject,
        message_ids: messageIds,
        audit_score: row.audit_score,
        source: row.source,
        sent_at: now,
      },
      actor_id: opts?.actorId ?? null,
    });
    await supabase
      .from("lead_outreach")
      .update({
        status: "sent",
        sent_to: sent,
        message_ids: messageIds,
        sent_at: now,
        error: null,
      })
      .eq("id", row.id);

    return { ok: true, sent: sent.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Send failed.";
    await supabase
      .from("lead_outreach")
      .update({ status: "failed", error: msg, attempts: row.attempts + 1 })
      .eq("id", row.id);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Suppression (opt-outs + bounces)
// ---------------------------------------------------------------------------

export async function suppressEmail(
  supabase: DB,
  email: string,
  reason: "unsubscribe" | "bounce" | "complaint" | "manual",
  leadId?: string | null,
): Promise<void> {
  const e = email.trim().toLowerCase();
  if (!e) return;
  await supabase
    .from("outreach_suppressions")
    .upsert({ email: e, reason, lead_id: leadId ?? null }, { onConflict: "email" });
}

async function dropSuppressed(supabase: DB, emails: string[]): Promise<string[]> {
  if (!emails.length) return emails;
  const lowered = emails.map((e) => e.trim().toLowerCase());
  const { data } = await supabase
    .from("outreach_suppressions")
    .select("email")
    .in("email", lowered);
  const blocked = new Set((data ?? []).map((r) => r.email));
  return emails.filter((e) => !blocked.has(e.trim().toLowerCase()));
}

// ---------------------------------------------------------------------------
// Unsubscribe token (HMAC) + footer
// ---------------------------------------------------------------------------

function unsubSecret(): string {
  return (
    process.env.OUTREACH_UNSUBSCRIBE_SECRET ||
    process.env.SMS_CRON_SECRET ||
    process.env.RESEND_API_KEY ||
    "arc-outreach"
  );
}

export function signUnsubscribe(email: string): string {
  return createHmac("sha256", unsubSecret())
    .update(email.trim().toLowerCase())
    .digest("hex");
}

export function verifyUnsubscribe(email: string, token: string): boolean {
  try {
    const expected = signUnsubscribe(email);
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function unsubscribeUrl(email: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || "https://arcai.online").replace(/\/$/, "");
  return `${base}/api/outreach/unsubscribe?e=${encodeURIComponent(
    email,
  )}&t=${signUnsubscribe(email)}`;
}

/**
 * The signature + CAN-SPAM footer appended to EVERY outreach pitch: ARC AI's
 * website, both phone numbers and the office address (sender identity /
 * physical address), plus the one-click unsubscribe link.
 */
function coldFooter(email: string): string {
  const phones = OUTREACH_CONTACT.phones
    .map((p) => `${p.label}: <a href="tel:${p.number.replace(/\s+/g, "")}" style="color:#475569;text-decoration:none;">${p.number}</a>`)
    .join(" &nbsp;·&nbsp; ");
  return `<div style="margin-top:28px;padding-top:16px;border-top:1px solid #eef0f6;color:#475569;font-size:13px;line-height:1.7;">
    <div style="font-weight:700;color:#0f172a;">${OUTREACH_CONTACT.name}</div>
    <div><a href="${OUTREACH_CONTACT.websiteUrl}" style="color:#f97316;text-decoration:none;">${OUTREACH_CONTACT.website}</a></div>
    <div>${phones}</div>
    <div>${OUTREACH_CONTACT.address}</div>
    <div style="margin-top:12px;color:#94a3b8;font-size:12px;line-height:1.6;">
      You're receiving this because we came across your business online.
      <a href="${unsubscribeUrl(email)}" style="color:#94a3b8;text-decoration:underline;">Unsubscribe</a> to never hear from us again.
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Add/remove tags on a lead (Set-merge, idempotent). */
async function setLeadTags(
  supabase: DB,
  leadId: string,
  add: string[] = [],
  remove: string[] = [],
): Promise<void> {
  const { data: lead } = await supabase
    .from("leads")
    .select("tags")
    .eq("id", leadId)
    .maybeSingle();
  const tags = new Set(lead?.tags ?? []);
  add.forEach((t) => tags.add(t));
  remove.forEach((t) => tags.delete(t));
  await supabase.from("leads").update({ tags: Array.from(tags) }).eq("id", leadId);
}

const JUNK_EMAIL_RE =
  /(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|abuse@|example\.|yourdomain|yoursite|sentry|wixpress|cloudflare|godaddy|privacyprotect|whoisguard|domainsbyproxy|\.png$|\.jpe?g$|\.webp$|\.gif$|\.svg$)/i;

/** Clean + rank scraped emails (own domain first), deduped, capped. */
function cleanEmails(emails: string[], ownDomain: string): string[] {
  const seen = new Set<string>();
  const cleaned = emails
    .map((e) => e.trim())
    .filter((e) => {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return false;
      if (JUNK_EMAIL_RE.test(e)) return false;
      const key = e.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const rank = (e: string): number => {
    const dom = e.split("@")[1]?.toLowerCase() ?? "";
    const own = ownDomain && (dom === ownDomain || dom.endsWith(`.${ownDomain}`));
    const generic = /^(info|hello|contact|sales|admin|office|mail|inquir|enquir)/i.test(e);
    return (own ? 0 : 2) + (generic ? 0 : 1);
  };
  return cleaned.sort((a, b) => rank(a) - rank(b)).slice(0, MAX_RECIPIENTS);
}

function domainOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}
