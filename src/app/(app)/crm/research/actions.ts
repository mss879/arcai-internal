"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { queueLeadResearch, drainResearchRow } from "@/lib/research";
import {
  isResearchConfigured,
  researchBranding,
  researchSiteAudit,
} from "@/lib/ai/lead-research";
import type { ActionResult } from "@/lib/types";

/**
 * Start (or restart) prospect research for a lead, on demand. Returns as
 * soon as the row is queued — the actual Firecrawl + OpenAI work runs
 * after the response via `after()`, so the click never hangs and can't
 * hit a serverless timeout. The UI shows a live "Researching…" state
 * (realtime), and the automation tick retries if this run is cut short.
 */
export async function requestLeadResearch(
  leadId: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  if (!isResearchConfigured()) {
    return {
      ok: false,
      error:
        "Research isn't configured. Add a FIRECRAWL_API_KEY (web scraping) and OPENAI_API_KEY (report writing) to enable it.",
    };
  }

  const { data: lead } = await supabase
    .from("leads")
    .select("company, title")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return { ok: false, error: "Lead not found." };

  const company = lead.company?.trim() || lead.title?.trim() || "";
  if (!company) {
    return {
      ok: false,
      error: "Add a company name to this lead before running research.",
    };
  }

  const queued = await queueLeadResearch(supabase, {
    leadId,
    company,
    requestedBy: user.id,
  });
  if (!queued.ok || !queued.id) {
    return { ok: false, error: "Could not start research." };
  }

  const researchId = queued.id;
  // Drive the whole pipeline after the response so the click returns instantly
  // and never times out; if the background pass is cut short the automation
  // tick resumes it. This finishes a report in ~one pass instead of waiting a
  // separate minute-tick per step.
  after(async () => {
    await drainResearchRow(supabase, researchId);
  });

  revalidatePath(`/crm/lead/${leadId}`);
  revalidatePath("/crm/research");
  return { ok: true };
}

/**
 * On-demand: fetch the prospect's brand system (colours/fonts/logo/personality)
 * and attach it to an existing report. Kept OUT of the initial research so the
 * first pass is fast and about the company — the report UI shows a "Grab
 * branding" button that calls this. ~15-20s, fits the serverless budget.
 */
export async function grabLeadBranding(
  researchId: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: row } = await supabase
    .from("lead_research")
    .select("id, lead_id, report")
    .eq("id", researchId)
    .maybeSingle();
  if (!row) return { ok: false, error: "Research report not found." };

  const report = (row.report ?? {}) as Record<string, unknown>;
  const website = typeof report.website === "string" ? report.website : "";
  if (!website)
    return { ok: false, error: "This report has no website to read branding from." };

  const result = await researchBranding(website);
  if (!result.ok)
    return {
      ok: false,
      error:
        result.reason === "empty"
          ? "Reached the site, but it exposes no brand system we could read (no colours or fonts detected)."
          : "Couldn't read the site's branding — it may be slow to load or blocking automated scans. Give it a moment and try again.",
    };
  const brand = result.brand;

  const { error } = await supabase
    .from("lead_research")
    .update({ report: { ...report, brand } })
    .eq("id", researchId);
  if (error) return { ok: false, error: error.message };

  if (row.lead_id) revalidatePath(`/crm/lead/${row.lead_id}`);
  revalidatePath("/crm/research");
  return { ok: true };
}

/**
 * On-demand: run the website audit (mobile PageSpeed + on-page SEO + domain
 * age/hosting) and attach the scorecard + domain facts to an existing report.
 * The report UI shows a "Run website audit" button that calls this.
 */
export async function runLeadWebsiteAudit(
  researchId: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: row } = await supabase
    .from("lead_research")
    .select("id, lead_id, report")
    .eq("id", researchId)
    .maybeSingle();
  if (!row) return { ok: false, error: "Research report not found." };

  const report = (row.report ?? {}) as Record<string, unknown>;
  const website = typeof report.website === "string" ? report.website : "";
  if (!website)
    return { ok: false, error: "This report has no website to audit." };

  const result = await researchSiteAudit(website);
  if (!result)
    return { ok: false, error: "Couldn't audit the site. Try again." };

  const { error } = await supabase
    .from("lead_research")
    .update({
      report: {
        ...report,
        audit: result.audit,
        domain_info: result.domain_info,
      },
    })
    .eq("id", researchId);
  if (error) return { ok: false, error: error.message };

  if (row.lead_id) revalidatePath(`/crm/lead/${row.lead_id}`);
  revalidatePath("/crm/research");
  return { ok: true };
}

/** Discard a research report. */
export async function deleteLeadResearch(
  id: string,
  leadId?: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase.from("lead_research").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };

  if (leadId) revalidatePath(`/crm/lead/${leadId}`);
  revalidatePath("/crm/research");
  return { ok: true };
}
