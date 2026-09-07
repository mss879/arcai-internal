"use server";

import { revalidatePath } from "next/cache";

import { generatePublicKey } from "@/lib/ai-projects/projects";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

export type NewAiProjectInput = {
  name: string;
  clientId?: string | null;
  websiteUrl?: string;
};

/** A new project starts as a draft: served only in the CRM's own preview
 * until the owner flips it to active on the Overview tab. */
export async function createAiProject(
  input: NewAiProjectInput,
): Promise<ActionResult<{ id: string }>> {
  const admin = await requireAdmin();
  const supabase = await createClient();

  const name = input.name?.trim() ?? "";
  if (!name) return { ok: false, error: "Give the project a name — usually the client's business." };
  if (name.length > 120) return { ok: false, error: "Keep the name under 120 characters." };

  let websiteUrl: string | null = null;
  const site = input.websiteUrl?.trim() ?? "";
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

  const { data, error } = await supabase
    .from("ai_projects")
    .insert({
      name,
      client_id: input.clientId || null,
      website_url: websiteUrl,
      public_key: generatePublicKey(),
      status: "draft",
      created_by: admin.id,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "Could not create the project." };

  revalidatePath("/ai-projects");
  return { ok: true, id: data.id };
}
