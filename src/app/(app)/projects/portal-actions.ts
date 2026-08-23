"use server";

/**
 * Handing a client their portal, and asking for a review (0094).
 *
 * Two outbound moments the team actually has: "here's where your project is,
 * go and look" and "we're done — would you say something nice?". Both go out
 * by SMS, both carry a link, and neither gives the client anything beyond the
 * one page it names.
 */

import { revalidatePath } from "next/cache";

import { appLink } from "@/lib/app-url";
import { generatePasscode } from "@/lib/portal-access";
import { portalMessage } from "@/lib/portal-copy";
import {
  firstName,
  projectClientContact,
  sendClientSms,
} from "@/lib/project-sms";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult, PortalLanguage } from "@/lib/types";

async function authed() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

// ---------------------------------------------------------------------------
// Passcode
// ---------------------------------------------------------------------------

export type PortalAccessInput = {
  /** "" clears the passcode and opens the link to anyone holding it. */
  passcode?: string | null;
  /** ISO date, or null for no expiry. */
  expiresAt?: string | null;
  language?: PortalLanguage;
};

/**
 * Set or clear the portal passcode, its expiry and its language.
 *
 * Changing the passcode invalidates every browser that had already unlocked
 * the portal — the cookie is an HMAC of the code itself — so this doubles as
 * "kick everyone out" without a session table.
 */
export async function savePortalAccess(
  projectId: string,
  input: PortalAccessInput,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  // Typed rather than Record<string, unknown> so a mistyped column name is a
  // compile error, not a silent no-op at runtime.
  const patch: Partial<{
    portal_passcode: string | null;
    portal_passcode_set_at: string | null;
    portal_failed_attempts: number;
    portal_locked_until: string | null;
    portal_expires_at: string | null;
    portal_language: PortalLanguage;
  }> = {};

  if (input.passcode !== undefined) {
    const code = (input.passcode ?? "").trim();
    if (code === "") {
      patch.portal_passcode = null;
      patch.portal_passcode_set_at = null;
    } else {
      if (!/^\d{4,8}$/.test(code)) {
        return {
          ok: false,
          error: "A passcode is 4–8 digits — easy to read out over the phone.",
        };
      }
      patch.portal_passcode = code;
      patch.portal_passcode_set_at = new Date().toISOString();
    }
    // Any change to the code clears the lockout and the strike count: the
    // client is about to be given a code that works.
    patch.portal_failed_attempts = 0;
    patch.portal_locked_until = null;
  }

  if (input.expiresAt !== undefined) {
    patch.portal_expires_at = input.expiresAt
      ? new Date(`${input.expiresAt}T23:59:59`).toISOString()
      : null;
  }
  if (input.language !== undefined) patch.portal_language = input.language;

  if (Object.keys(patch).length === 0) return { ok: true };

  const { error } = await supabase
    .from("projects")
    .update(patch)
    .eq("id", projectId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

/** A fresh code, so nobody has to invent one. */
export async function rollPortalPasscode(
  projectId: string,
): Promise<ActionResult & { passcode?: string }> {
  const code = generatePasscode();
  const res = await savePortalAccess(projectId, { passcode: code });
  if (!res.ok) return res;
  return { ok: true, passcode: code };
}

/** Kill a link that has gone somewhere it shouldn't have. */
export async function setPortalRevoked(
  projectId: string,
  revoked: boolean,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("projects")
    .update({ portal_revoked_at: revoked ? new Date().toISOString() : null })
    .eq("id", projectId);
  if (error) return { ok: false, error: error.message };

  const { logDeliveryEvent } = await import("@/lib/delivery");
  await logDeliveryEvent(
    supabase,
    projectId,
    "portal_locked",
    revoked ? "Portal link revoked" : "Portal link re-opened",
    "team",
  );

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Send the portal to the client
// ---------------------------------------------------------------------------

export type SendPortalResult = ActionResult & { preview?: string };

/**
 * Text the client their portal link, and the passcode with it.
 *
 * Deliberately one message, not two: a client who gets a link in one text and
 * a code in another will lose one of them. Anyone able to read the text can
 * open the portal — which is the same person the link was addressed to.
 */
export async function sendPortalToClient(
  projectId: string,
  opts?: { note?: string },
): Promise<SendPortalResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: project } = await supabase
    .from("projects")
    .select("id, name, share_token, portal_passcode, portal_revoked_at")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) return { ok: false, error: "Project not found." };
  if (!project.share_token) {
    return { ok: false, error: "This project has no portal link yet." };
  }
  if (project.portal_revoked_at) {
    return {
      ok: false,
      error: "The portal link is revoked — re-open it before sending.",
    };
  }

  const link = appLink(`/public/project/${project.share_token}`);
  if (!link) {
    return {
      ok: false,
      error: "NEXT_PUBLIC_APP_URL isn't set, so there's no link to send.",
    };
  }

  const contact = await projectClientContact(supabase, projectId);
  if ("error" in contact) return { ok: false, error: contact.error };

  const message = portalMessage({
    name: firstName(contact.clientName),
    projectName: contact.projectName,
    link,
    passcode: project.portal_passcode,
    note: opts?.note,
  });

  const res = await sendClientSms(supabase, {
    contact,
    message,
    kind: "custom",
    actorId: user.id,
    eventDetail: project.portal_passcode
      ? "Portal link + passcode texted to the client"
      : "Portal link texted to the client",
  });
  if (!res.ok) return { ok: false, error: res.error };

  await supabase
    .from("projects")
    .update({ portal_last_sent_at: new Date().toISOString() })
    .eq("id", projectId);

  const { logDeliveryEvent } = await import("@/lib/delivery");
  await logDeliveryEvent(
    supabase,
    projectId,
    "portal_sent",
    `Portal sent to ${contact.clientName}`,
    "team",
  );

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/sms");
  return { ok: true, preview: message };
}

// ---------------------------------------------------------------------------
// Ask for a review
// ---------------------------------------------------------------------------

export type AskReviewResult = ActionResult & { link?: string | null };

/**
 * Ask the client for a review.
 *
 * The link goes to a page of its own — a rating, a few words, and a yes/no on
 * whether we may publish it. Not the portal: a review request should not hand
 * out access to the project, and a client who is about to be asked for praise
 * shouldn't be dropped into a page about outstanding assets.
 */
export async function askForReview(projectId: string): Promise<AskReviewResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const contact = await projectClientContact(supabase, projectId);
  if ("error" in contact) return { ok: false, error: contact.error };

  // An outstanding ask is re-sent rather than duplicated, so the client can't
  // end up with two links that write two different rows.
  const { data: existing } = await supabase
    .from("project_reviews")
    .select("id, share_token, status")
    .eq("project_id", projectId)
    .eq("status", "requested")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let token = existing?.share_token ?? null;
  let reviewId = existing?.id ?? null;

  if (!token) {
    const { data: created, error } = await supabase
      .from("project_reviews")
      .insert({
        project_id: projectId,
        client_name: contact.clientName,
        requested_by: user.id,
      })
      .select("id, share_token")
      .single();
    if (error || !created) {
      return { ok: false, error: error?.message ?? "Couldn't create the review." };
    }
    token = created.share_token;
    reviewId = created.id;
  }

  const link = appLink(`/public/review/${token}`);
  if (!link) {
    return {
      ok: false,
      error: "NEXT_PUBLIC_APP_URL isn't set, so there's no link to send.",
    };
  }

  const res = await sendClientSms(supabase, {
    contact,
    message: [
      `Hi ${firstName(contact.clientName)}, we've wrapped up ${contact.projectName} — thank you!`,
      `If you have a minute, we'd really appreciate a quick word about how it went:`,
      link,
      "— ARC AI",
    ].join("\n"),
    kind: "custom",
    actorId: user.id,
    eventDetail: `Review requested from ${contact.clientName}`,
  });
  if (!res.ok) return { ok: false, error: res.error };

  await Promise.all([
    supabase
      .from("projects")
      .update({ review_requested_at: new Date().toISOString() })
      .eq("id", projectId),
    reviewId
      ? supabase
          .from("project_reviews")
          .update({ reminded_at: new Date().toISOString() })
          .eq("id", reviewId)
      : Promise.resolve(),
  ]);

  const { logDeliveryEvent } = await import("@/lib/delivery");
  await logDeliveryEvent(
    supabase,
    projectId,
    "review_requested",
    `Review asked of ${contact.clientName}`,
    "team",
  );

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/sms");
  return { ok: true, link };
}
