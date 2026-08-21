"use server";

import { revalidatePath } from "next/cache";
import { STORAGE_BUCKETS } from "@/lib/constants";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ActionResult } from "@/lib/types";

/** Matches the WhatsApp inbound guard — and stays under next.config's
 * serverActions.bodySizeLimit (12mb) with multipart overhead to spare. */
const MAX_PORTAL_FILE_BYTES = 10 * 1024 * 1024;

export async function uploadPortalFile(
  token: string,
  requestId: string,
  formData: FormData
): Promise<ActionResult> {
  try {
    const supabase = createAdminClient();

    // 1. Fetch project with this share_token
    const { data: project, error: pError } = await supabase
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
    if (file.size > MAX_PORTAL_FILE_BYTES) {
      return {
        ok: false,
        error: "That file is over 10MB — please compress it or send it to us on WhatsApp.",
      };
    }

    // Convert File to ArrayBuffer then Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Client assets live in the project's own bucket (0084) — they used to
    // land in `resources`, polluting the internal team file share. Old
    // submissions keep working: file_url is stored absolute.
    const cleanFileName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_");
    const path = `assets/${project.id}/${requestId}-${Date.now()}-${cleanFileName}`;

    // Upload file bypassing RLS using service role
    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKETS.projectDocs)
      .upload(path, buffer, {
        contentType: file.type,
        duplex: "half",
      });

    if (uploadError) {
      return { ok: false, error: uploadError.message };
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from(STORAGE_BUCKETS.projectDocs)
      .getPublicUrl(path);

    // Update the document request status
    const { data: updated, error: dbError } = await supabase
      .from("project_document_requests")
      .update({
        status: "submitted",
        file_url: urlData.publicUrl,
        file_name: file.name,
        file_size: file.size,
        file_type: file.type || null,
        source: "portal",
        submitted_at: new Date().toISOString(),
      })
      .eq("id", requestId)
      .eq("project_id", project.id)
      .select("id, project_id, title")
      .single();

    if (dbError) {
      return { ok: false, error: dbError.message };
    }

    // 0085 — an asset landing is a delivery event: log it, fire the
    // asset_submitted automations, and check whether that was the last
    // required item (assets_complete). Never let this break the upload.
    if (updated) {
      try {
        const [{ logDeliveryEvent }, { fireAssetSubmitted }] = await Promise.all([
          import("@/lib/delivery"),
          import("@/lib/wa-onboarding"),
        ]);
        await logDeliveryEvent(
          supabase,
          updated.project_id,
          "asset_submitted",
          `"${updated.title}" uploaded on the portal (${file.name})`,
          "portal",
          { request_id: updated.id },
        );
        await fireAssetSubmitted(supabase, updated, "portal");
      } catch (e) {
        console.error("[portal] asset_submitted follow-through failed:", e);
      }
    }

    revalidatePath(`/public/project/${token}`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "Internal server error during upload.",
    };
  }
}
