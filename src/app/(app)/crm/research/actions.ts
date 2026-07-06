"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { queueLeadResearch, runResearchRow } from "@/lib/research";
import { isResearchConfigured } from "@/lib/ai/lead-research";
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
  after(async () => {
    await runResearchRow(supabase, {
      id: researchId,
      lead_id: leadId,
      company_name: company,
    });
  });

  revalidatePath(`/crm/lead/${leadId}`);
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
