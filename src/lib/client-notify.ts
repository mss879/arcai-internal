import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { logOutboundWa, withinWaWindow } from "@/lib/delivery";
import { isSmsConfigured, sendSms } from "@/lib/sms";
import { countSmsSegments, normalizePhone } from "@/lib/sms-utils";
import { isWhatsAppConfigured, sendWhatsAppText } from "@/lib/whatsapp";

type DB = SupabaseClient<Database>;

/**
 * One way to tell a client something outside an open thread (0120).
 *
 * The portal-send ladder, generalised: a slip confirmation, a recurring
 * reminder, a "your invoice is ready" — anything the CRM says to a client on
 * its own initiative — walks the same rungs, so the choice of channel is
 * made once:
 *
 *   1. WhatsApp, as free text, while the client's 24h window is open.
 *   2. SMS, the way the CRM has always reached a client.
 *   3. A task for the team, when nothing above could send — a confirmation
 *      at 11pm must not be lost because Notify.lk is unconfigured.
 *
 * No template rung here on purpose: there is exactly one approved template
 * (the portal link) and it says the wrong thing for everything else. When
 * the slip-confirmation and reminder templates are approved by Meta, this is
 * the one place to add them.
 *
 * Never used for a reply inside a conversation — that is the inbox's job.
 */

export type NotifyClientInput = {
  clientId?: string | null;
  /** Resolves the client through the project when clientId isn't known. */
  projectId?: string | null;
  /** The message, in the client's own words. */
  message: string;
  /** What this is about, for the SMS log and the fallback task. */
  kind: "slip" | "reminder" | "invoice" | "system";
  /** Who set it off; null for the tick. */
  actorId?: string | null;
  /** The invoice this concerns, for the SMS log. */
  invoiceId?: string | null;
};

export type NotifyClientResult =
  | { ok: true; channel: "whatsapp" | "sms"; to: string }
  | { ok: false; error: string; taskCreated: boolean };

export async function notifyClient(db: DB, input: NotifyClientInput): Promise<NotifyClientResult> {
  const message = input.message.trim();
  if (!message) return { ok: false, error: "Nothing to say.", taskCreated: false };

  // --- Who ---------------------------------------------------------------
  let clientId = input.clientId ?? null;
  let projectName: string | null = null;
  if (!clientId && input.projectId) {
    const { data: project } = await db
      .from("projects")
      .select("name, client_id")
      .eq("id", input.projectId)
      .maybeSingle();
    clientId = project?.client_id ?? null;
    projectName = project?.name ?? null;
  }
  if (!clientId) {
    return { ok: false, error: "No client to tell.", taskCreated: false };
  }
  const { data: client } = await db
    .from("clients")
    .select("id, name, phone")
    .eq("id", clientId)
    .maybeSingle();
  if (!client) return { ok: false, error: "That client no longer exists.", taskCreated: false };

  const phone = client.phone?.trim() ? normalizePhone(client.phone) : null;
  if (!phone?.ok) {
    const taskCreated = await raiseTask(db, client.name, projectName, message, "no phone number on their record");
    return { ok: false, error: `${client.name} has no usable phone number.`, taskCreated };
  }

  // --- 1. WhatsApp, while the window is open ------------------------------
  if (isWhatsAppConfigured()) {
    const { data: wa } = await db
      .from("wa_contacts")
      .select("id, wa_id, last_inbound_at, do_not_contact")
      .eq("wa_id", phone.value)
      .maybeSingle();
    if (wa && !wa.do_not_contact && withinWaWindow(wa.last_inbound_at)) {
      const sent = await sendWhatsAppText({ to: wa.wa_id, body: message });
      await logOutboundWa(db, wa.id, message, sent.ok ? sent.waMessageId : null, sent.ok, sent.ok ? undefined : sent.error);
      if (sent.ok) return { ok: true, channel: "whatsapp", to: wa.wa_id };
      // fall through to SMS
    }
  }

  // --- 2. SMS ---------------------------------------------------------------
  if (isSmsConfigured()) {
    const sent = await sendSms({ to: phone.value, message, contactName: client.name });
    await db.from("sms_messages").insert({
      to_number: phone.value,
      message,
      client_id: client.id,
      client_name: client.name,
      kind: input.kind === "reminder" ? "payment_reminder" : "custom",
      status: sent.ok ? "sent" : "failed",
      error: sent.ok ? null : sent.error,
      segments: countSmsSegments(message),
      created_by: input.actorId ?? null,
    });
    if (sent.ok) return { ok: true, channel: "sms", to: phone.value };
    const taskCreated = await raiseTask(db, client.name, projectName, message, sent.error);
    return { ok: false, error: sent.error, taskCreated };
  }

  // --- 3. Somebody sends it by hand ---------------------------------------
  const taskCreated = await raiseTask(
    db,
    client.name,
    projectName,
    message,
    "WhatsApp's window is closed and SMS isn't configured",
  );
  return { ok: false, error: "No channel could send this.", taskCreated };
}

async function raiseTask(
  db: DB,
  clientName: string,
  projectName: string | null,
  message: string,
  why: string,
): Promise<boolean> {
  try {
    const { error } = await db.from("crm_tasks").insert({
      lead_id: null,
      title: `Message ${clientName} by hand${projectName ? ` (${projectName})` : ""}`,
      notes: `The CRM couldn't send this itself — ${why}.\n\n${message}`,
      due_at: new Date().toISOString(),
      created_by: null,
    });
    return !error;
  } catch {
    return false;
  }
}
