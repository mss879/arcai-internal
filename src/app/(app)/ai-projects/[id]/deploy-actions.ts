"use server";

import { revalidatePath } from "next/cache";

import { parseOriginList } from "@/lib/ai-projects/origin-core";
import { invalidateProjectMemo } from "@/lib/ai-projects/projects";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

/** The Deploy tab's one write (0126): which websites may use this project. */
export async function saveAllowedOrigins(id: string, text: string): Promise<ActionResult<{ origins: string[]; invalid: string[] }>> {
  await requireAdmin();
  const supabase = await createClient();
  const { data: project } = await supabase.from("ai_projects").select("id, public_key").eq("id", id).maybeSingle();
  if (!project) return { ok: false, error: "That project no longer exists." };

  const { origins, invalid } = parseOriginList(text);
  if (invalid.length) {
    return { ok: false, error: `Not a website address: ${invalid.slice(0, 3).join(", ")}. Use forms like example.com, https://www.example.com or *.example.com.` };
  }
  if (origins.length > 20) return { ok: false, error: "Keep it to twenty origins." };

  const { error } = await supabase.from("ai_projects").update({ allowed_origins: origins }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  invalidateProjectMemo(project.public_key);
  revalidatePath(`/ai-projects/${id}`);
  return { ok: true, origins, invalid };
}
