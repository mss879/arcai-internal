import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { appLink } from "@/lib/app-url";
import type { Database, SmsKind } from "@/lib/database.types";
import { isSmsConfigured, sendSms } from "@/lib/sms";
import { SMS_MAX_LENGTH, countSmsSegments, normalizePhone } from "@/lib/sms-utils";

type DB = SupabaseClient<Database>;

/**
 * Texting a project's client (0093).
 *
 * One way in, so every message a client receives about their project is
 * normalised, length-checked, logged to `sms_messages` with the project on it,
 * and recorded on the project's own history. Nothing here sends silently: a
 * failure comes back as a sentence the team can act on rather than a
 * swallowed error, because "did the client get told?" is not a question the
 * system should be vague about.
 */

export type ClientSmsResult =
  | { ok: true; to: string; segments: number }
  | { ok: false; error: string };

export type ProjectClientContact = {
  projectId: string;
  projectName: string;
  clientId: string | null;
  clientName: string;
  phone: string | null;
};

/** Resolve who to text for a project, or explain why we can't. */
export async function projectClientContact(
  db: DB,
  projectId: string,
): Promise<ProjectClientContact | { error: string }> {
  const { data: project } = await db
    .from("projects")
    .select("id, name, client_id, client:clients(id, name, phone)")
    .eq("id", projectId)
    .maybeSingle();

  if (!project) return { error: "Project not found." };

  const client = project.client as unknown as {
    id: string;
    name: string;
    phone: string | null;
  } | null;

  if (!client) {
    return {
      error: "This project has no client attached, so there's nobody to text.",
    };
  }

  return {
    projectId: project.id,
    projectName: project.name,
    clientId: client.id,
    clientName: client.name,
    phone: client.phone,
  };
}

/**
 * Send one message to a project's client.
 *
 * `logEvent` puts a line on the project's History tab as well — on by default,
 * because a text the team can't see afterwards may as well not have been sent.
 */
export async function sendClientSms(
  db: DB,
  opts: {
    contact: ProjectClientContact;
    message: string;
    kind?: SmsKind;
    invoiceId?: string | null;
    /** Who pressed the button; null for anything the tick sent. */
    actorId?: string | null;
    logEvent?: boolean;
    eventDetail?: string;
  },
): Promise<ClientSmsResult> {
  if (!isSmsConfigured()) {
    return {
      ok: false,
      error: "SMS isn't configured — add the Notify.lk keys to send texts.",
    };
  }

  const phone = normalizePhone(opts.contact.phone ?? "");
  if (!phone.ok) {
    return {
      ok: false,
      error: opts.contact.phone
        ? `${opts.contact.clientName}'s phone number isn't valid: ${phone.error}`
        : `${opts.contact.clientName} has no phone number on their client record.`,
    };
  }

  const message = opts.message.trim();
  if (!message) return { ok: false, error: "The message is empty." };
  if (message.length > SMS_MAX_LENGTH) {
    return {
      ok: false,
      error: `Message is too long (${message.length}/${SMS_MAX_LENGTH} characters).`,
    };
  }

  const result = await sendSms({
    to: phone.value,
    message,
    contactName: opts.contact.clientName || undefined,
  });

  // Logged either way: a failed send is part of the history, not an absence.
  await db.from("sms_messages").insert({
    to_number: phone.value,
    message,
    client_id: opts.contact.clientId,
    client_name: opts.contact.clientName,
    kind: opts.kind ?? "custom",
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
    invoice_id: opts.invoiceId ?? null,
    project_id: opts.contact.projectId,
    segments: countSmsSegments(message),
    created_by: opts.actorId ?? null,
  });

  if (opts.logEvent !== false) {
    try {
      const { logDeliveryEvent } = await import("@/lib/delivery");
      await logDeliveryEvent(
        db,
        opts.contact.projectId,
        "milestone_sent",
        result.ok
          ? (opts.eventDetail ?? `Texted the client: "${preview(message)}"`)
          : `Text to the client FAILED — ${result.error}`,
        opts.actorId ? "team" : "automation",
        { channel: "sms", to: phone.value },
      );
    } catch {
      // History is a nicety; never let it fail the send.
    }
  }

  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, to: phone.value, segments: countSmsSegments(message) };
}

/** First words of a message, for a history line. */
function preview(message: string): string {
  return message.length > 60 ? `${message.slice(0, 57)}…` : message;
}

/**
 * The public link to an invoice.
 *
 * Returns null when NEXT_PUBLIC_APP_URL isn't set — callers then send
 * link-free copy rather than a broken URL, which is the existing convention
 * everywhere else that texts a link.
 */
export function invoiceLink(shareToken: string | null | undefined): string | null {
  if (!shareToken) return null;
  return appLink(`/public/invoice/${shareToken}`);
}

/** First name, the way every other outbound message addresses a client. */
export function firstName(name: string): string {
  return (name || "").trim().split(/\s+/)[0] || "there";
}
