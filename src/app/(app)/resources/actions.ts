"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import type { ActionResult, ResourceKind } from "@/lib/types";

export type ResourceInput = {
  name: string;
  description?: string;
  kind: ResourceKind;
  file_url?: string | null;
  file_path?: string | null;
  file_type?: string | null;
  file_size?: number | null;
  link_url?: string | null;
};

export async function createResource(
  input: ResourceInput,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!input.name?.trim()) return { ok: false, error: "Give it a name." };
  if (input.kind === "link" && !input.link_url?.trim()) {
    return { ok: false, error: "Enter a URL." };
  }
  if (input.kind === "file" && !input.file_url) {
    return { ok: false, error: "Upload a file." };
  }

  const { error } = await supabase.from("resources").insert({
    name: input.name.trim(),
    description: input.description?.trim() || null,
    kind: input.kind,
    file_url: input.file_url || null,
    file_path: input.file_path || null,
    file_type: input.file_type || null,
    file_size: input.file_size || null,
    link_url: input.link_url?.trim() || null,
  });

  if (error) return { ok: false, error: error.message };
  revalidatePath("/resources");
  return { ok: true };
}

export async function deleteResource(
  id: string,
  filePath?: string | null,
): Promise<ActionResult> {
  const supabase = await createClient();
  if (filePath) {
    await supabase.storage.from("resources").remove([filePath]);
  }
  const { error } = await supabase.from("resources").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/resources");
  return { ok: true };
}
