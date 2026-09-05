"use server";

import { revalidatePath } from "next/cache";
import { getProfile } from "@/lib/auth";
import { STORAGE_BUCKETS } from "@/lib/constants";
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

// ---- Deliverables (0117) --------------------------------------------------

/** 10MB, matching the portal's own upload cap. */
const MAX_DELIVERABLE_BYTES = 10 * 1024 * 1024;

/**
 * Put a finished file where the client can get it.
 *
 * `projects.documents` was two URLs typed onto the project row, which is why
 * "send them the logo files" was still an email with an attachment. A
 * deliverable is a row: it has a version, and it is invisible to the client
 * until somebody says otherwise — a file lands in the project first and is
 * shared on purpose, never by being uploaded.
 */
export async function uploadDeliverable(
  projectId: string,
  formData: FormData,
): Promise<ActionResult> {
  const profile = await getProfile();
  if (!profile) return { ok: false, error: "Not signed in." };

  const file = formData.get("file");
  if (!(file instanceof File) || !file.size) {
    return { ok: false, error: "Pick a file first." };
  }
  if (file.size > MAX_DELIVERABLE_BYTES) {
    return { ok: false, error: "That file is over 10MB." };
  }

  const title = String(formData.get("title") ?? "").trim() || file.name;
  const supabase = await createClient();

  // A file with the same title is a new VERSION, not a second row to confuse
  // the client with.
  const { data: previous } = await supabase
    .from("project_deliverables")
    .select("version")
    .eq("project_id", projectId)
    .eq("title", title)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const version = (previous?.version ?? 0) + 1;

  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "-");
  const path = `deliverables/${projectId}/${version}-${safe}`;

  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKETS.projectDocs)
    .upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (uploadError) return { ok: false, error: uploadError.message };

  const { error } = await supabase.from("project_deliverables").insert({
    project_id: projectId,
    title,
    file_path: path,
    mime: file.type || null,
    size_bytes: file.size,
    version,
    uploaded_by: profile.id,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

/** Show or hide a deliverable on the client's portal. */
export async function setDeliverableVisibility(
  id: string,
  projectId: string,
  visible: boolean,
): Promise<ActionResult> {
  const profile = await getProfile();
  if (!profile) return { ok: false, error: "Not signed in." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("project_deliverables")
    .update({ visible_to_client: visible })
    .eq("id", id)
    .eq("project_id", projectId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

export async function deleteDeliverable(
  id: string,
  projectId: string,
): Promise<ActionResult> {
  const profile = await getProfile();
  if (!profile) return { ok: false, error: "Not signed in." };

  const supabase = await createClient();
  const { data: row } = await supabase
    .from("project_deliverables")
    .select("file_path")
    .eq("id", id)
    .eq("project_id", projectId)
    .maybeSingle();

  const { error } = await supabase
    .from("project_deliverables")
    .delete()
    .eq("id", id)
    .eq("project_id", projectId);
  if (error) return { ok: false, error: error.message };

  // The row is the record; a leftover object is tidier to lose than a row.
  if (row?.file_path) {
    await supabase.storage
      .from(STORAGE_BUCKETS.projectDocs)
      .remove([row.file_path])
      .catch(() => undefined);
  }

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}
