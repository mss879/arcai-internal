"use server";

import { revalidatePath } from "next/cache";

import { generatePublicKey, invalidateProjectMemo } from "@/lib/ai-projects/projects";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult, AiProjectStatus } from "@/lib/types";

/** The Overview tab's actions (0126): basics, status, the snippet key. */

async function loadProject(id: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("ai_projects")
    .select("id, public_key, status")
    .eq("id", id)
    .maybeSingle();
  return { supabase, project: data };
}

function refresh(id: string) {
  revalidatePath("/ai-projects");
  revalidatePath(`/ai-projects/${id}`);
}

export type AiProjectBasicsInput = {
  name: string;
  clientId: string | null;
  websiteUrl: string;
};

export async function updateAiProjectBasics(
  id: string,
  input: AiProjectBasicsInput,
): Promise<ActionResult> {
  await requireAdmin();
  const { supabase, project } = await loadProject(id);
  if (!project) return { ok: false, error: "That project no longer exists." };

  const name = input.name.trim();
  if (!name) return { ok: false, error: "The project needs a name." };
  if (name.length > 120) return { ok: false, error: "Keep the name under 120 characters." };

  let websiteUrl: string | null = null;
  const site = input.websiteUrl.trim();
  if (site) {
    const withScheme = /^https?:\/\//i.test(site) ? site : `https://${site}`;
    try {
      const url = new URL(withScheme);
      if (!url.hostname.includes(".")) throw new Error("no tld");
      websiteUrl = `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
      return { ok: false, error: "That website address doesn't look right." };
    }
  }

  const { error } = await supabase
    .from("ai_projects")
    .update({ name, client_id: input.clientId || null, website_url: websiteUrl })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  invalidateProjectMemo(project.public_key);
  refresh(id);
  return { ok: true };
}

const SETTABLE: AiProjectStatus[] = ["draft", "active", "paused"];

export async function setAiProjectStatus(
  id: string,
  status: AiProjectStatus,
): Promise<ActionResult> {
  await requireAdmin();
  if (!SETTABLE.includes(status)) return { ok: false, error: "Use Archive for that." };
  const { supabase, project } = await loadProject(id);
  if (!project) return { ok: false, error: "That project no longer exists." };

  const { error } = await supabase.from("ai_projects").update({ status }).eq("id", id);
  if (error) return { ok: false, error: error.message };

  invalidateProjectMemo(project.public_key);
  refresh(id);
  return { ok: true };
}

/** Archived, never deleted: the usage ledger and past invoices reference it. */
export async function archiveAiProject(id: string): Promise<ActionResult> {
  await requireAdmin();
  const { supabase, project } = await loadProject(id);
  if (!project) return { ok: false, error: "That project no longer exists." };
  const { error } = await supabase
    .from("ai_projects")
    .update({ status: "archived", crawl_interval_days: null, next_crawl_at: null })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  invalidateProjectMemo(project.public_key);
  refresh(id);
  return { ok: true };
}

/**
 * A new key. The old one stops working the moment the memo expires (a
 * minute on other instances, at once here), so the client must update
 * their snippet — the Overview tab says so before this runs.
 */
export async function rotatePublicKey(id: string): Promise<ActionResult<{ key: string }>> {
  await requireAdmin();
  const { supabase, project } = await loadProject(id);
  if (!project) return { ok: false, error: "That project no longer exists." };
  const key = generatePublicKey();
  const { error } = await supabase.from("ai_projects").update({ public_key: key }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  invalidateProjectMemo(project.public_key);
  refresh(id);
  return { ok: true, key };
}
