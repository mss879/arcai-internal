"use server";

import { revalidatePath } from "next/cache";

import { isFirecrawlConfigured } from "@/lib/ai/firecrawl";
import { ACTIVE_CRAWL_STATUSES } from "@/lib/ai-projects/crawl-core";
import { stepCrawlJob } from "@/lib/ai-projects/crawl";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

/** "Crawl now" and "Cancel" (0126). The first step runs inline with the
 * page's own window; the tick carries the job on from there. */

const INLINE_BUDGET_MS = 18_000;

export async function startCrawl(projectId: string): Promise<ActionResult<{ jobId: string }>> {
  await requireAdmin();
  const supabase = await createClient();
  if (!isFirecrawlConfigured()) return { ok: false, error: "Crawling needs FIRECRAWL_API_KEY on the server." };

  const { data: project } = await supabase.from("ai_projects").select("id, website_url, status").eq("id", projectId).maybeSingle();
  if (!project) return { ok: false, error: "That project no longer exists." };
  if (!project.website_url) return { ok: false, error: "Set the project's website first (Overview tab)." };
  if (project.status === "archived") return { ok: false, error: "Restore the project before crawling." };

  const { data: active } = await supabase
    .from("ai_crawl_jobs")
    .select("id")
    .eq("project_id", projectId)
    .in("status", [...ACTIVE_CRAWL_STATUSES])
    .limit(1)
    .maybeSingle();
  if (active) return { ok: false, error: "A crawl is already running." };

  const { data: job, error } = await supabase
    .from("ai_crawl_jobs")
    .insert({ project_id: projectId, status: "queued", triggered_by: "manual", errors: [] })
    .select("id")
    .single();
  if (error || !job) return { ok: false, error: error?.message ?? "Could not start the crawl." };

  await stepCrawlJob(supabase, job.id, { budgetMs: INLINE_BUDGET_MS });
  revalidatePath(`/ai-projects/${projectId}`);
  return { ok: true, jobId: job.id };
}

export async function cancelCrawl(projectId: string, jobId: string): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();
  const { error } = await supabase
    .from("ai_crawl_jobs")
    .update({ status: "cancelled", finished_at: new Date().toISOString(), lease_until: null })
    .eq("id", jobId)
    .eq("project_id", projectId)
    .in("status", [...ACTIVE_CRAWL_STATUSES]);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/ai-projects/${projectId}`);
  return { ok: true };
}
