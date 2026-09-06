"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import type { ActionResult, ResourceKind } from "@/lib/types";

/**
 * The Resources library: files, links, and the folders they sit in (0123).
 *
 * A folder is a row in its own table, not a third `kind` of resource — so
 * everything that already reads `resources` keeps getting only real files and
 * links, and nothing had to learn to filter.
 */

export type ResourceInput = {
  name: string;
  description?: string;
  kind: ResourceKind;
  file_url?: string | null;
  file_path?: string | null;
  file_type?: string | null;
  file_size?: number | null;
  link_url?: string | null;
  folder_id?: string | null;
};

function rowFor(input: ResourceInput) {
  return {
    name: input.name.trim(),
    description: input.description?.trim() || null,
    kind: input.kind,
    file_url: input.file_url || null,
    file_path: input.file_path || null,
    file_type: input.file_type || null,
    file_size: input.file_size || null,
    link_url: input.link_url?.trim() || null,
    folder_id: input.folder_id || null,
  };
}

function validate(input: ResourceInput): string | null {
  if (!input.name?.trim()) return "Give it a name.";
  if (input.kind === "link" && !input.link_url?.trim()) return "Enter a URL.";
  if (input.kind === "file" && !input.file_url) return "Upload a file.";
  return null;
}

export async function createResource(
  input: ResourceInput,
): Promise<ActionResult> {
  return createResources([input]);
}

/**
 * Several resources in ONE insert.
 *
 * The multi-file upload is the reason this exists: dropping twelve files used
 * to mean twelve server round-trips, and a failure halfway left the library
 * holding half an upload with nothing to say which half. One statement either
 * lands or doesn't.
 */
export async function createResources(
  inputs: ResourceInput[],
): Promise<ActionResult<{ count: number }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!inputs.length) return { ok: false, error: "Nothing to add." };

  for (const input of inputs) {
    const problem = validate(input);
    if (problem) return { ok: false, error: problem };
  }

  const { error } = await supabase.from("resources").insert(inputs.map(rowFor));
  if (error) return { ok: false, error: error.message };
  revalidatePath("/resources");
  return { ok: true, count: inputs.length };
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

/** Move resources into a folder, or back out to the top level with `null`. */
export async function moveResources(
  ids: string[],
  folderId: string | null,
): Promise<ActionResult> {
  if (!ids.length) return { ok: true };
  const supabase = await createClient();
  const { error } = await supabase
    .from("resources")
    .update({ folder_id: folderId })
    .in("id", ids);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/resources");
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Folders                                                              */
/* ------------------------------------------------------------------ */

export async function createFolder(
  name: string,
  description?: string,
): Promise<ActionResult<{ id: string }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!name.trim()) return { ok: false, error: "Give the folder a name." };

  const { data, error } = await supabase
    .from("resource_folders")
    .insert({ name: name.trim(), description: description?.trim() || null })
    .select("id")
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not create the folder." };
  }
  revalidatePath("/resources");
  return { ok: true, id: data.id };
}

export async function renameFolder(
  id: string,
  name: string,
  description?: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  if (!name.trim()) return { ok: false, error: "Give the folder a name." };
  const { error } = await supabase
    .from("resource_folders")
    .update({ name: name.trim(), description: description?.trim() || null })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/resources");
  return { ok: true };
}

/**
 * Delete a folder. What is inside it is NOT deleted.
 *
 * `resources.folder_id` is ON DELETE SET NULL, so the files fall back to the
 * top level. Deleting a container must never be a way to lose a dozen files
 * you can't get back — the confirm dialog says exactly this before you press it.
 */
export async function deleteFolder(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("resource_folders").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/resources");
  return { ok: true };
}
