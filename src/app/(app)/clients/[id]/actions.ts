"use server";

import { revalidatePath } from "next/cache";

import { appLink } from "@/lib/app-url";
import { getProfile } from "@/lib/auth";
import { notifyClient } from "@/lib/client-notify";
import { logOutboundWa, waContactForClient, withinWaWindow } from "@/lib/delivery";
import { firstNameOf } from "@/lib/email-templates";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";
import { isWhatsAppConfigured, sendWhatsAppDocument } from "@/lib/whatsapp";

/**
 * Sending a client their statement (T4.6).
 *
 * Email goes through the compose modal (`attachStatement` on
 * sendComposedEmail), so it lands in the log like every other send. This is
 * the WhatsApp path: the PDF itself as a document message while the
 * client's 24h window is open — the first real use of `sendWhatsAppDocument`
 * — and otherwise the link, through `notifyClient()`'s ladder (SMS, then a
 * task), so a statement asked for at 11pm is never silently dropped.
 */
export async function sendStatementByWhatsApp(
  clientId: string,
  period: { from?: string | null; to?: string | null } = {},
): Promise<ActionResult<{ channel: "whatsapp" | "sms" }>> {
  const profile = await getProfile();
  if (!profile) return { ok: false, error: "Not signed in." };

  const supabase = await createClient();
  const { data: client } = await supabase
    .from("clients")
    .select("id, name, phone, statement_token")
    .eq("id", clientId)
    .maybeSingle();
  if (!client) return { ok: false, error: "That client no longer exists." };
  if (!client.statement_token) {
    return { ok: false, error: "This client has no statement link yet (migration 0117)." };
  }
  if (!client.phone?.trim()) {
    return { ok: false, error: `${client.name} has no phone number on their record.` };
  }

  const qs = new URLSearchParams();
  if (period.from) qs.set("from", period.from);
  if (period.to) qs.set("to", period.to);
  const suffix = qs.toString() ? `?${qs}` : "";
  const pdfLink = appLink(`/api/public/statement/${client.statement_token}/pdf${suffix}`);
  const pageLink = appLink(`/public/statement/${client.statement_token}${suffix}`);
  if (!pdfLink || !pageLink) {
    return { ok: false, error: "NEXT_PUBLIC_APP_URL isn't set, so there is no link to send." };
  }

  const first = firstNameOf(client.name);
  const caption = `Hi ${first}, here's your statement of account from ARC AI. Reply here if anything looks off.`;

  // --- The document itself, while the window is open --------------------
  if (isWhatsAppConfigured()) {
    const wa = await waContactForClient(supabase, client.id);
    if (wa && withinWaWindow(wa.last_inbound_at)) {
      const safe = client.name.replace(/[^a-zA-Z0-9._-]/g, "") || "client";
      const sent = await sendWhatsAppDocument({
        to: wa.wa_id,
        link: pdfLink,
        filename: `Statement-${safe}.pdf`,
        caption,
      });
      await logOutboundWa(
        supabase,
        wa.id,
        `📄 Statement of account (PDF) — ${caption}`,
        sent.ok ? sent.waMessageId : null,
        sent.ok,
        sent.ok ? undefined : sent.error,
      );
      if (sent.ok) {
        revalidatePath(`/clients/${client.id}`);
        return { ok: true, channel: "whatsapp" };
      }
      // A failed document send falls through to the link.
    }
  }

  // --- The link, by whatever reaches them ---------------------------------
  const res = await notifyClient(supabase, {
    clientId: client.id,
    kind: "system",
    actorId: profile.id,
    message: `Hi ${first}, here's your statement of account from ARC AI: ${pageLink}`,
  });
  revalidatePath(`/clients/${client.id}`);
  if (!res.ok) {
    return {
      ok: false,
      error: res.taskCreated
        ? `${res.error} A task has been raised to send it by hand.`
        : res.error,
    };
  }
  return { ok: true, channel: res.channel };
}
