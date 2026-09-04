import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { appLink } from "@/lib/app-url";
import type { Database } from "@/lib/database.types";
import {
  getDeliverySettings,
  logDeliveryEvent,
  logOutboundWa,
  withinWaWindow,
} from "@/lib/delivery";
import { portalCtaBody, portalMessage } from "@/lib/portal-copy";
import {
  firstName,
  projectClientContact,
  sendClientSms,
  type ProjectClientContact,
} from "@/lib/project-sms";
import {
  choosePortalChannel,
  type PortalSendChannel,
} from "@/lib/portal-send-core";
import { isSmsConfigured } from "@/lib/sms";
import {
  isWhatsAppConfigured,
  normalizeWaPhone,
  sendWhatsAppCtaUrl,
  sendWhatsAppTemplate,
} from "@/lib/whatsapp";

type DB = SupabaseClient<Database>;

/**
 * The one way a client is handed their tracking link (0112).
 *
 * Four things used to send it — the Client tab's button, the
 * `send_portal_link` automation step, and (now) project creation and the
 * assistant — and each would have grown its own idea of which channel to
 * use. They all come through here, so the ladder is decided once:
 *
 *   1. WhatsApp, as a message with an "Open your project" button, while the
 *      client's 24h window is open (they wrote to us recently).
 *   2. WhatsApp, as the approved portal template, when the window is closed
 *      and Delivery → Settings names one.
 *   3. SMS, the way the link has always gone out.
 *   4. A task for the team, when nothing above could send — a project
 *      created at 11pm must not fail because Notify.lk is unconfigured.
 *
 * Every success stamps `portal_last_sent_at` and writes ONE `portal_sent`
 * line on the project's History with the channel in its meta, whoever sent
 * it. A revoked link never goes out.
 */

// Re-exported: the ladder's channel type lives with the ladder's decision.
export type { PortalSendChannel };
export type PortalSendActor = "team" | "automation" | "creation" | "assistant";

export type PortalSendFailure =
  | "no_client"
  | "no_phone"
  | "revoked"
  | "no_link"
  | "already_sent"
  | "not_configured"
  | "send_failed";

export type PortalSendResult =
  | {
      ok: true;
      channel: "whatsapp" | "whatsapp_template" | "sms";
      to: string;
      /** The text as it went out (the template send previews its body params). */
      preview: string;
    }
  | {
      ok: false;
      reason: PortalSendFailure;
      error: string;
      /** A crm_tasks row was raised so a human sends it by hand. */
      taskCreated?: boolean;
    };

export type SendPortalOptions = {
  channel?: PortalSendChannel;
  actor: PortalSendActor;
  /** The signed-in user behind a team/creation/assistant send. */
  actorId?: string | null;
  /** Extra line under the link (an automation's "your invoice is here…"). */
  note?: string | null;
  /** Creation uses this so a re-saved project never texts twice. */
  onlyIfNeverSent?: boolean;
};

const BUTTON_TEXT = "Open your project";

export async function sendPortalLink(
  supabase: DB,
  projectId: string,
  opts: SendPortalOptions,
): Promise<PortalSendResult> {
  const channel: PortalSendChannel = opts.channel ?? "auto";

  const { data: project } = await supabase
    .from("projects")
    .select(
      "id, name, client_id, share_token, portal_passcode, portal_revoked_at, portal_last_sent_at, deleted_at",
    )
    .eq("id", projectId)
    .maybeSingle();
  if (!project || project.deleted_at) {
    return { ok: false, reason: "no_link", error: "Project not found." };
  }
  if (!project.share_token) {
    return { ok: false, reason: "no_link", error: "This project has no portal link yet." };
  }
  if (project.portal_revoked_at) {
    return {
      ok: false,
      reason: "revoked",
      error: "The portal link is revoked — re-open it before sending.",
    };
  }
  if (opts.onlyIfNeverSent && project.portal_last_sent_at) {
    return {
      ok: false,
      reason: "already_sent",
      error: "The link has already been sent to this client.",
    };
  }

  const link = appLink(`/public/project/${project.share_token}`);
  if (!link) {
    return {
      ok: false,
      reason: "no_link",
      error: "NEXT_PUBLIC_APP_URL isn't set, so there's no link to send.",
    };
  }

  const contact = await projectClientContact(supabase, projectId);
  if ("error" in contact) {
    return { ok: false, reason: "no_client", error: contact.error };
  }
  if (!contact.phone?.trim()) {
    const error = `${contact.clientName} has no phone number on their client record.`;
    const taskCreated = await raiseTask(supabase, opts.actor, contact, error);
    return { ok: false, reason: "no_phone", error, taskCreated };
  }

  const name = firstName(contact.clientName);
  const note = opts.note?.trim() || undefined;
  const passcode = project.portal_passcode;

  // ---- 1 + 2: WhatsApp ------------------------------------------------
  // Which rung to try is decided by choosePortalChannel() in
  // portal-send-core.ts, so the ladder can be tested without Meta or
  // Notify.lk. Everything below is the sending.
  const waConfigured = isWhatsAppConfigured();
  const wa =
    channel !== "sms" && waConfigured
      ? await resolveWaContact(supabase, contact)
      : null;
  const windowOpen = wa ? withinWaWindow(wa.last_inbound_at) : false;
  // The template only matters once the window has shut, so the common path
  // doesn't pay for the settings read.
  const settings =
    wa && !wa.do_not_contact && !windowOpen
      ? await getDeliverySettings(supabase)
      : null;

  const choice = choosePortalChannel({
    requested: channel,
    whatsappConfigured: waConfigured,
    wa: wa ? { doNotContact: Boolean(wa.do_not_contact), windowOpen } : null,
    portalTemplate: settings?.portal_template_name?.trim() || null,
    smsConfigured: isSmsConfigured(),
    clientName: contact.clientName,
  });
  let whatsappProblem = choice.whatsappProblem;

  if (choice.rung === "whatsapp_cta" && wa) {
    const body = portalCtaBody({ name, projectName: contact.projectName, passcode, note });
    const sent = await sendWhatsAppCtaUrl({
      to: wa.wa_id,
      bodyText: body,
      buttonText: BUTTON_TEXT,
      url: link,
    });
    const preview = `${body}\n${link}`;
    await logOutboundWa(
      supabase,
      wa.id,
      preview,
      sent.ok ? sent.waMessageId : null,
      sent.ok,
      sent.ok ? undefined : sent.error,
    );
    if (sent.ok) {
      return recordSuccess(supabase, project.id, opts, {
        channel: "whatsapp",
        to: wa.wa_id,
        preview,
        clientName: contact.clientName,
      });
    }
    whatsappProblem = sent.error;
  } else if (choice.rung === "whatsapp_template" && wa && settings) {
    const template = settings.portal_template_name!.trim();
    const passcodeLine = passcode ? `Passcode: ${passcode}` : "No passcode needed";
    const sent = await sendWhatsAppTemplate({
      to: wa.wa_id,
      template,
      language: settings.portal_template_lang || "en",
      bodyParams: [name, contact.projectName, passcodeLine],
      urlButtonParam: project.share_token,
    });
    const preview = `[template: ${template}] ${name} · ${contact.projectName} · ${passcodeLine}\n${link}`;
    await logOutboundWa(
      supabase,
      wa.id,
      preview,
      sent.ok ? sent.waMessageId : null,
      sent.ok,
      sent.ok ? undefined : sent.error,
    );
    if (sent.ok) {
      return recordSuccess(supabase, project.id, opts, {
        channel: "whatsapp_template",
        to: wa.wa_id,
        preview,
        clientName: contact.clientName,
      });
    }
    whatsappProblem = sent.error;
  }

  if (channel === "whatsapp") {
    return {
      ok: false,
      reason: "send_failed",
      error: `Couldn't send on WhatsApp — ${whatsappProblem ?? "unknown error"}.`,
    };
  }

  // ---- 3: SMS ---------------------------------------------------------
  const message = portalMessage({
    name,
    projectName: contact.projectName,
    link,
    passcode,
    note,
  });
  if (!isSmsConfigured()) {
    const error = whatsappProblem
      ? `WhatsApp: ${whatsappProblem} SMS isn't configured either.`
      : "SMS isn't configured — add the Notify.lk keys to send texts.";
    const taskCreated = await raiseTask(supabase, opts.actor, contact, error);
    return { ok: false, reason: "not_configured", error, taskCreated };
  }
  const sms = await sendClientSms(supabase, {
    contact,
    message,
    kind: "custom",
    actorId: opts.actorId ?? null,
    // This module writes the one portal_sent line itself.
    logEvent: false,
  });
  if (!sms.ok) {
    const taskCreated = await raiseTask(supabase, opts.actor, contact, sms.error);
    return {
      ok: false,
      reason: /phone/i.test(sms.error) ? "no_phone" : "send_failed",
      error: sms.error,
      taskCreated,
    };
  }
  return recordSuccess(supabase, project.id, opts, {
    channel: "sms",
    to: sms.to,
    preview: message,
    clientName: contact.clientName,
  });
}

// ---------------------------------------------------------------------------

type WaRow = Pick<
  Database["public"]["Tables"]["wa_contacts"]["Row"],
  "id" | "wa_id" | "last_inbound_at" | "do_not_contact"
>;

/**
 * The client's WhatsApp thread, or one created from the phone on their
 * record — the same way onboarding starts a conversation. An existing
 * contact with that number (a lead's thread, say) is reused and linked to
 * the client rather than overwritten.
 */
async function resolveWaContact(
  supabase: DB,
  contact: ProjectClientContact,
): Promise<WaRow | null> {
  const fields = "id, wa_id, last_inbound_at, do_not_contact";
  if (contact.clientId) {
    const { data } = await supabase
      .from("wa_contacts")
      .select(fields)
      .eq("client_id", contact.clientId)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (data) return data;
  }

  const phone = normalizeWaPhone(contact.phone ?? "");
  if (!phone.ok) return null;

  const { data: byNumber } = await supabase
    .from("wa_contacts")
    .select(`${fields}, client_id`)
    .eq("wa_id", phone.value)
    .maybeSingle();
  if (byNumber) {
    if (!byNumber.client_id && contact.clientId) {
      await supabase
        .from("wa_contacts")
        .update({ client_id: contact.clientId })
        .eq("id", byNumber.id);
    }
    return byNumber;
  }

  const { data: created } = await supabase
    .from("wa_contacts")
    .insert({
      wa_id: phone.value,
      display_name: contact.clientName,
      client_id: contact.clientId,
    })
    .select(fields)
    .maybeSingle();
  return created ?? null;
}

async function recordSuccess(
  supabase: DB,
  projectId: string,
  opts: SendPortalOptions,
  sent: {
    channel: "whatsapp" | "whatsapp_template" | "sms";
    to: string;
    preview: string;
    clientName: string;
  },
): Promise<PortalSendResult> {
  await supabase
    .from("projects")
    .update({ portal_last_sent_at: new Date().toISOString() })
    .eq("id", projectId);

  const via = sent.channel === "sms" ? "SMS" : "WhatsApp";
  const how =
    opts.actor === "creation"
      ? "when the project was created"
      : opts.actor === "automation"
        ? "by an automation"
        : opts.actor === "assistant"
          ? "by Arcus"
          : "by the team";
  try {
    await logDeliveryEvent(
      supabase,
      projectId,
      "portal_sent",
      `Portal link sent to ${sent.clientName} on ${via} ${how}`,
      opts.actor === "automation" ? "automation" : "team",
      {
        channel: sent.channel,
        to: sent.to,
        actor: opts.actor,
        actor_id: opts.actorId ?? null,
      },
    );
  } catch {
    // History is a nicety; the message already went.
  }

  return { ok: true, channel: sent.channel, to: sent.to, preview: sent.preview };
}

/**
 * When an automatic send can't happen, hand it to a person rather than
 * letting the client silently never hear from us. Team sends surface the
 * error in the UI instead, so no task is raised for them.
 */
async function raiseTask(
  supabase: DB,
  actor: PortalSendActor,
  contact: ProjectClientContact,
  why: string,
): Promise<boolean> {
  if (actor === "team") return false;
  try {
    const { error } = await supabase.from("crm_tasks").insert({
      lead_id: null,
      title: `Send the tracking link manually — ${contact.clientName} (${contact.projectName})`,
      notes: `The portal link couldn't go out automatically: ${why} Open the project → Client tab → Send to client once that's fixed.`,
      due_at: new Date().toISOString(),
      created_by: null,
    });
    return !error;
  } catch {
    return false;
  }
}
