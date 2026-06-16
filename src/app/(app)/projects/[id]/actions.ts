"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

async function authed() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

export async function createDocumentRequest(
  projectId: string,
  title: string,
  description?: string
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!title?.trim()) return { ok: false, error: "Title is required." };

  const { error } = await (supabase as any).from("project_document_requests").insert({
    project_id: projectId,
    title: title.trim(),
    description: description?.trim() || null,
    status: "pending",
  });

  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

export async function deleteDocumentRequest(
  id: string,
  projectId: string
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await (supabase as any)
    .from("project_document_requests")
    .delete()
    .eq("id", id)
    .eq("project_id", projectId);

  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

export async function regenerateShareToken(
  projectId: string
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await (supabase as any)
    .from("projects")
    .update({ share_token: crypto.randomUUID() })
    .eq("id", projectId);

  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}
