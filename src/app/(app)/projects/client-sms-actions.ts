"use server";

/**
 * Telling the client something, by text (0093).
 *
 * The workspace already tracks a lot the client would like to know — stages
 * moving, milestones landing, assets arriving — and until now the only way any
 * of it reached them was WhatsApp, which needs an open 24-hour window and an
 * approved template. SMS has neither constraint, so this is what the team
 * reaches for when something genuinely matters.
 *
 * Everything here is opt-in per message. Nothing on this page texts a client
 * because a checkbox was left ticked six weeks ago — except a milestone
 * explicitly marked "tell the client", and that fires exactly once.
 */

import { revalidatePath } from "next/cache";

import { DELIVERY_STAGE_META } from "@/lib/constants";
import {
  firstName,
  projectClientContact,
  sendClientSms,
} from "@/lib/project-sms";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult, DeliveryStage } from "@/lib/types";

async function authed() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

/** Whether this project can be texted at all — drives the UI's disabled state. */
export async function clientSmsTarget(
  projectId: string,
): Promise<{ ok: true; name: string; phone: string | null } | { ok: false; error: string }> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const contact = await projectClientContact(supabase, projectId);
  if ("error" in contact) return { ok: false, error: contact.error };
  return { ok: true, name: contact.clientName, phone: contact.phone };
}

/** Free-text message to the project's client. */
export async function messageClient(
  projectId: string,
  message: string,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const contact = await projectClientContact(supabase, projectId);
  if ("error" in contact) return { ok: false, error: contact.error };

  const res = await sendClientSms(supabase, {
    contact,
    message: message.trim(),
    kind: "custom",
    actorId: user.id,
  });
  if (!res.ok) return { ok: false, error: res.error };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/sms");
  return { ok: true };
}

/**
 * Tell the client a milestone has landed.
 *
 * Used both by the "Text the client" button and automatically when a
 * milestone marked `notify_sms` is completed. `notified_at` is what makes the
 * automatic path safe: ticking, un-ticking and re-ticking a milestone texts
 * the client once, not three times.
 */
export async function textMilestone(
  milestoneId: string,
  opts?: { force?: boolean },
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: milestone } = await supabase
    .from("project_milestones")
    .select("id, project_id, title, detail, notified_at, client_visible, kind")
    .eq("id", milestoneId)
    .maybeSingle();
  if (!milestone) return { ok: false, error: "Milestone not found." };

  // Launch checks are the internal gate — a client reading "SSL certificate
  // live" learns only that it might not have been.
  if (milestone.kind === "launch_check") {
    return { ok: false, error: "Launch checks are internal — the client isn't told about them." };
  }
  if (milestone.notified_at && !opts?.force) {
    return { ok: false, error: "The client has already been told about this one." };
  }

  const contact = await projectClientContact(supabase, milestone.project_id);
  if ("error" in contact) return { ok: false, error: contact.error };

  const body = [
    `Hi ${firstName(contact.clientName)}, an update on "${contact.projectName}": ${milestone.title} is done.`,
    milestone.detail?.trim() || null,
    "— ARC AI",
  ]
    .filter(Boolean)
    .join("\n");

  const res = await sendClientSms(supabase, {
    contact,
    message: body,
    kind: "custom",
    actorId: user.id,
    eventDetail: `Client texted: "${milestone.title}" completed`,
  });
  if (!res.ok) return { ok: false, error: res.error };

  await supabase
    .from("project_milestones")
    .update({ notified_at: new Date().toISOString() })
    .eq("id", milestoneId);

  revalidatePath(`/projects/${milestone.project_id}`);
  revalidatePath("/sms");
  return { ok: true };
}

/**
 * Tell the client the project has moved to a new stage.
 *
 * Uses the client-facing wording from DELIVERY_STAGE_META, so the text says
 * "Building your project" rather than leaking the internal stage name.
 */
export async function textStageUpdate(
  projectId: string,
  stage: DeliveryStage,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const meta = DELIVERY_STAGE_META[stage];
  if (!meta) return { ok: false, error: "Unknown stage." };

  const contact = await projectClientContact(supabase, projectId);
  if ("error" in contact) return { ok: false, error: contact.error };

  const res = await sendClientSms(supabase, {
    contact,
    message: `Hi ${firstName(contact.clientName)}, "${contact.projectName}" has moved on — we're now at: ${meta.clientLabel}.\n— ARC AI`,
    kind: "custom",
    actorId: user.id,
    eventDetail: `Client texted the stage update: ${meta.label}`,
  });
  if (!res.ok) return { ok: false, error: res.error };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/sms");
  return { ok: true };
}
