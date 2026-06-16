"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ActionResult } from "@/lib/types";

export async function uploadPortalFile(
  token: string,
  requestId: string,
  formData: FormData
): Promise<ActionResult> {
  try {
    const supabase = createAdminClient();

    // 1. Fetch project with this share_token
    const { data: project, error: pError } = await (supabase as any)
      .from("projects")
      .select("id, status")
      .eq("share_token", token)
      .single();

    if (pError || !project) {
      return { ok: false, error: "Project link is invalid or expired." };
    }

    if (project.status === "completed") {
      return { ok: false, error: "This project has been completed and is now locked." };
    }

    const file = formData.get("file") as File;
    if (!file) {
      return { ok: false, error: "No file was selected." };
    }

    // Convert File to ArrayBuffer then Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Generate a unique path in 'resources' bucket
    const cleanFileName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_");
    const path = `portal/${project.id}/${requestId}-${Date.now()}-${cleanFileName}`;

    // Upload file bypassing RLS using service role
    const { error: uploadError } = await supabase.storage
      .from("resources")
      .upload(path, buffer, {
        contentType: file.type,
        duplex: "half",
      });

    if (uploadError) {
      return { ok: false, error: uploadError.message };
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from("resources")
      .getPublicUrl(path);

    // Update the document request status
    const { error: dbError } = await (supabase as any)
      .from("project_document_requests")
      .update({
        status: "submitted",
        file_url: urlData.publicUrl,
        file_name: file.name,
        submitted_at: new Date().toISOString(),
      })
      .eq("id", requestId)
      .eq("project_id", project.id);

    if (dbError) {
      return { ok: false, error: dbError.message };
    }

    revalidatePath(`/public/project/${token}`);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Internal server error during upload." };
  }
}
