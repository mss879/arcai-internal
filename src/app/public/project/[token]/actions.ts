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

/**
 * Unlock a passcode-protected portal (0094).
 *
 * Public and unauthenticated, so it has to defend itself. Two rules:
 *
 *   • the token comes first — a wrong token is a dead end regardless of the
 *     code, so the search space is the UUID, not the six digits;
 *   • wrong codes are counted and the portal shuts for a while. That counter
 *     is what makes a code short enough to read out over the phone safe.
 *
 * The reply never distinguishes "no such project" from "wrong code": both are
 * simply "that didn't work".
 */
export async function unlockPortal(
  token: string,
  passcode: string,
): Promise<{ ok: true } | { ok: false; error: string; lockedUntil?: string }> {
  const supabase = createAdminClient();

  const { data: project } = await supabase
    .from("projects")
    .select(
      "id, portal_passcode, portal_failed_attempts, portal_locked_until, portal_revoked_at, portal_expires_at",
    )
    .eq("share_token", token)
    .maybeSingle();

  const generic = "That code didn't work.";
  if (!project?.portal_passcode) return { ok: false, error: generic };

  if (project.portal_revoked_at) {
    return { ok: false, error: "This link is no longer active." };
  }
  if (
    project.portal_expires_at &&
    new Date(project.portal_expires_at).getTime() < Date.now()
  ) {
    return { ok: false, error: "This link has expired." };
  }

  if (
    project.portal_locked_until &&
    new Date(project.portal_locked_until).getTime() > Date.now()
  ) {
    return {
      ok: false,
      error: "Too many attempts — try again shortly.",
      lockedUntil: project.portal_locked_until,
    };
  }

  const {
    MAX_PORTAL_ATTEMPTS,
    PORTAL_LOCK_MINUTES,
    grantPortalAccess,
    passcodeMatches,
  } = await import("@/lib/portal-access");

  if (!passcodeMatches(passcode, project.portal_passcode)) {
    const attempts = (project.portal_failed_attempts ?? 0) + 1;
    const locked = attempts >= MAX_PORTAL_ATTEMPTS;
    const lockedUntil = locked
      ? new Date(Date.now() + PORTAL_LOCK_MINUTES * 60_000).toISOString()
      : null;

    await supabase
      .from("projects")
      .update({
        portal_failed_attempts: locked ? 0 : attempts,
        portal_locked_until: lockedUntil,
      })
      .eq("id", project.id);

    if (locked) {
      // Worth the team knowing: either the client is struggling, or someone
      // who shouldn't have the link is trying codes.
      const { logDeliveryEvent } = await import("@/lib/delivery");
      await logDeliveryEvent(
        supabase,
        project.id,
        "portal_locked",
        `Portal locked for ${PORTAL_LOCK_MINUTES} minutes after ${MAX_PORTAL_ATTEMPTS} wrong codes`,
        "portal",
      );
      return {
        ok: false,
        error: "Too many attempts — try again shortly.",
        lockedUntil: lockedUntil ?? undefined,
      };
    }

    return { ok: false, error: generic };
  }

  await supabase
    .from("projects")
    .update({ portal_failed_attempts: 0, portal_locked_until: null })
    .eq("id", project.id);

  await grantPortalAccess(token, project.portal_passcode);

  const { logDeliveryEvent } = await import("@/lib/delivery");
  await logDeliveryEvent(
    supabase,
    project.id,
    "portal_unlocked",
    "Client opened the portal",
    "portal",
  );

  revalidatePath(`/public/project/${token}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Everything below is reachable by direct POST, not just through the page.
// Each one re-resolves the token AND re-checks the passcode gate, because a
// server action is a public endpoint the moment it exists.
// ---------------------------------------------------------------------------

type OpenPortal = {
  id: string;
  name: string;
  status: string;
  clientName: string | null;
};

/**
 * Resolve a token to a project the caller is actually allowed to write to.
 *
 * Returns a sentence rather than a project when the link is dead or still
 * locked — the callers turn that straight into what the client sees.
 */
async function openPortal(
  token: string,
): Promise<{ project: OpenPortal } | { error: string }> {
  const supabase = createAdminClient();
  const { data: project } = await supabase
    .from("projects")
    .select(
      "id, name, status, portal_passcode, portal_expires_at, portal_revoked_at, portal_locked_until, portal_failed_attempts, client:clients(name)",
    )
    .eq("share_token", token)
    .maybeSingle();
  if (!project) return { error: "This link is no longer active." };

  const { checkPortalGate } = await import("@/lib/portal-access");
  const gate = await checkPortalGate({
    token,
    passcode: project.portal_passcode,
    expiresAt: project.portal_expires_at,
    revokedAt: project.portal_revoked_at,
    lockedUntil: project.portal_locked_until,
    failedAttempts: project.portal_failed_attempts ?? 0,
  });
  if (gate.state !== "open") {
    return { error: "Please enter your passcode first." };
  }

  const client = project.client as unknown as { name: string } | null;
  return {
    project: {
      id: project.id,
      name: project.name,
      status: project.status,
      clientName: client?.name ?? null,
    },
  };
}

/** The client asks for something beyond the agreed scope (CX-3). */
export async function submitChangeRequest(
  token: string,
  body: string,
): Promise<ActionResult> {
  const opened = await openPortal(token);
  if ("error" in opened) return { ok: false, error: opened.error };

  const text = body.trim();
  if (!text) return { ok: false, error: "Tell us what you'd like changed." };
  if (text.length > 2000) {
    return { ok: false, error: "That's a long one — could you shorten it?" };
  }

  const supabase = createAdminClient();
  const { error } = await supabase.from("project_change_requests").insert({
    project_id: opened.project.id,
    body: text,
    source: "portal",
    client_name: opened.project.clientName,
  });
  if (error) return { ok: false, error: error.message };

  const { logDeliveryEvent } = await import("@/lib/delivery");
  const { notifyEveryone } = await import("@/lib/wa-agent");
  await logDeliveryEvent(
    supabase,
    opened.project.id,
    "change_requested",
    text.length > 90 ? `${text.slice(0, 87)}…` : text,
    "portal",
  );
  // Worth interrupting someone for: an unanswered change request is either a
  // frustrated client or money left on the table.
  await notifyEveryone(supabase, {
    title: `Change requested — ${opened.project.name}`,
    body: text.length > 120 ? `${text.slice(0, 117)}…` : text,
    link: `/projects/${opened.project.id}`,
  });

  revalidatePath(`/public/project/${token}`);
  return { ok: true };
}

/** The client signs off, or asks for changes instead (CX-2). */
export async function respondToApproval(
  token: string,
  approvalId: string,
  decision: "approved" | "changes_requested",
  signerName: string,
  note?: string,
): Promise<ActionResult> {
  const opened = await openPortal(token);
  if ("error" in opened) return { ok: false, error: opened.error };

  const name = signerName.trim();
  if (decision === "approved" && !name) {
    return { ok: false, error: "Please type your name to sign this off." };
  }

  const supabase = createAdminClient();
  // Scoped by project too: an approval id from another project must not be
  // signable with this token.
  const { data: updated, error } = await supabase
    .from("project_approvals")
    .update({
      status: decision,
      signer_name: name || opened.project.clientName,
      signed_at: new Date().toISOString(),
      response_note: note?.trim() || null,
    })
    .eq("id", approvalId)
    .eq("project_id", opened.project.id)
    .eq("status", "pending")
    .select("id, title")
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!updated) {
    return { ok: false, error: "That one has already been answered." };
  }

  const { logDeliveryEvent } = await import("@/lib/delivery");
  const { notifyEveryone } = await import("@/lib/wa-agent");
  await logDeliveryEvent(
    supabase,
    opened.project.id,
    "approval_signed",
    decision === "approved"
      ? `${updated.title} — approved by ${name}`
      : `${updated.title} — changes requested`,
    "portal",
  );
  await notifyEveryone(supabase, {
    title:
      decision === "approved"
        ? `Signed off: ${updated.title}`
        : `Changes requested: ${updated.title}`,
    body: `${opened.project.name}${note?.trim() ? ` — ${note.trim()}` : ""}`,
    link: `/projects/${opened.project.id}`,
  });

  // 0096 — "they said yes" is the cue for invoicing, building and shipping.
  // Only an approval, never a changes-requested: those are two different
  // events and a recipe that treated them alike would bill on a rejection.
  if (decision === "approved") {
    const { fireClientApproved } = await import("@/lib/project-events");
    await fireClientApproved(supabase, opened.project.id, {
      id: updated.id,
      title: updated.title,
      signerName: name || opened.project.clientName,
    });
  }

  revalidatePath(`/public/project/${token}`);
  return { ok: true };
}

/** A note from the client, optionally against a milestone (CX-4). */
export async function postClientComment(
  token: string,
  body: string,
  milestoneId?: string | null,
): Promise<ActionResult> {
  const opened = await openPortal(token);
  if ("error" in opened) return { ok: false, error: opened.error };

  const text = body.trim();
  if (!text) return { ok: false, error: "Write something first." };
  if (text.length > 2000) return { ok: false, error: "That's too long to send." };

  const supabase = createAdminClient();
  const { error } = await supabase.from("project_comments").insert({
    project_id: opened.project.id,
    // Only accept a milestone that belongs to this project.
    milestone_id: milestoneId
      ? (
          await supabase
            .from("project_milestones")
            .select("id")
            .eq("id", milestoneId)
            .eq("project_id", opened.project.id)
            .maybeSingle()
        ).data?.id ?? null
      : null,
    author_type: "client",
    author_name: opened.project.clientName ?? "Client",
    body: text,
  });
  if (error) return { ok: false, error: error.message };

  const { logDeliveryEvent } = await import("@/lib/delivery");
  const { notifyEveryone } = await import("@/lib/wa-agent");
  await logDeliveryEvent(
    supabase,
    opened.project.id,
    "comment",
    text.length > 90 ? `${text.slice(0, 87)}…` : text,
    "portal",
  );
  await notifyEveryone(supabase, {
    title: `Client comment — ${opened.project.name}`,
    body: text.length > 120 ? `${text.slice(0, 117)}…` : text,
    link: `/projects/${opened.project.id}`,
  });

  revalidatePath(`/public/project/${token}`);
  return { ok: true };
}

/**
 * One tap on "how's it going" (CX-9).
 *
 * An unhappy tap raises a churn alert — the whole point is hearing about it
 * while there is still a project left to fix.
 */
export async function sendPulse(
  token: string,
  score: 1 | 2 | 3,
  note?: string,
): Promise<ActionResult> {
  const opened = await openPortal(token);
  if ("error" in opened) return { ok: false, error: opened.error };
  if (![1, 2, 3].includes(score)) return { ok: false, error: "Pick one." };

  const supabase = createAdminClient();
  const { error } = await supabase.from("project_pulses").insert({
    project_id: opened.project.id,
    score,
    note: note?.trim() || null,
  });
  if (error) return { ok: false, error: error.message };

  const { logDeliveryEvent } = await import("@/lib/delivery");
  const { notifyEveryone } = await import("@/lib/wa-agent");
  const label = score === 1 ? "unhappy" : score === 2 ? "fine" : "delighted";
  await logDeliveryEvent(
    supabase,
    opened.project.id,
    "pulse",
    `Client says: ${label}`,
    "portal",
  );

  if (score === 1) {
    await notifyEveryone(supabase, {
      title: `Unhappy client — ${opened.project.name}`,
      body: note?.trim() || "They tapped the unhappy face on the portal.",
      link: `/projects/${opened.project.id}`,
    });
    // Feeds the existing churn board rather than inventing a second one.
    await supabase.from("churn_alerts").insert({
      client_name: opened.project.clientName ?? opened.project.name,
      severity: "cold",
      reason: `Unhappy pulse on "${opened.project.name}"${note?.trim() ? `: ${note.trim()}` : ""}`,
    });
  }

  revalidatePath(`/public/project/${token}`);
  return { ok: true };
}
