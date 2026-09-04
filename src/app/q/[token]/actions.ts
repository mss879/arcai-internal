"use server";

import { headers } from "next/headers";

import { createAdminClient } from "@/lib/supabase/admin";
import { fireAutomationTrigger } from "@/lib/automation";
import { resolveOrCreateClient } from "@/lib/contacts";
import { markLeadWon } from "@/lib/leads";
import { notifyUsers } from "@/lib/notify";
import { enforceRateLimit } from "@/lib/rate-limit";
import type { ActionResult } from "@/lib/types";

/**
 * Public quote actions (no auth — the share token is the credential).
 * Uses the admin client because the visitor has no Supabase session.
 */

/**
 * 0116 — signing is a once-per-quote act, so a stream of attempts against one
 * token is either a bug or somebody probing. Bucketed by token: a real signer
 * never sees this.
 */
async function quoteLimit(token: string): Promise<string | null> {
  const res = await enforceRateLimit(createAdminClient(), `quote:${token}`, {
    limit: 20,
    windowSec: 600,
  });
  return res.ok ? null : "Too many attempts. Give it a minute.";
}

export async function acceptQuote(input: {
  token: string;
  signedName: string;
  signatureData: string;
}): Promise<ActionResult> {
  if (!input.signedName.trim())
    return { ok: false, error: "Please type your full name." };
  if (!input.signatureData)
    return { ok: false, error: "Please draw your signature." };

  const busy = await quoteLimit(input.token);
  if (busy) return { ok: false, error: busy };

  const supabase = createAdminClient();
  const { data: quote } = await supabase
    .from("quotes")
    .select("*")
    .eq("share_token", input.token)
    .maybeSingle();
  if (!quote) return { ok: false, error: "This quote no longer exists." };
  if (quote.status === "accepted")
    return { ok: false, error: "This quote is already accepted." };
  if (quote.status === "declined")
    return { ok: false, error: "This quote was declined." };

  const headerList = await headers();
  const ip =
    headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    headerList.get("x-real-ip") ??
    null;

  const { error } = await supabase
    .from("quotes")
    .update({
      status: "accepted",
      signed_name: input.signedName.trim(),
      signature_data: input.signatureData,
      signed_ip: ip,
      accepted_at: new Date().toISOString(),
    })
    .eq("id", quote.id);
  if (error) return { ok: false, error: error.message };

  const lead = quote.lead_id
    ? (await supabase.from("leads").select("*").eq("id", quote.lead_id).single()).data
    : null;

  // 0112 — a signed quote is a client, whatever record it started as. Find
  // them by phone or email, or create them from the quote, and write the
  // link onto the quote AND the lead so the chain reads in every direction.
  // Best-effort: a hiccup here must never un-accept a signed quote.
  let client: { id: string; name: string; email?: string | null; phone?: string | null } | null =
    null;
  try {
    const knownId = quote.client_id ?? lead?.client_id ?? null;
    if (knownId) {
      const { data } = await supabase
        .from("clients")
        .select("id, name, email, phone")
        .eq("id", knownId)
        .maybeSingle();
      client = data ?? null;
    }
    if (!client) {
      const resolved = await resolveOrCreateClient(supabase, {
        name: quote.customer_name,
        phone: quote.customer_phone,
        email: quote.customer_email,
        company: lead?.company ?? null,
      });
      if ("client" in resolved) client = resolved.client;
    }
    if (client) {
      if (!quote.client_id)
        await supabase.from("quotes").update({ client_id: client.id }).eq("id", quote.id);
      if (lead && !lead.client_id)
        await supabase.from("leads").update({ client_id: client.id }).eq("id", lead.id);
    }
    // The deal is won — say so on the pipeline, not just on the quote.
    if (lead && lead.status !== "won") await markLeadWon(supabase, lead.id);
  } catch (e) {
    console.error("[quote] client/lead link after acceptance failed:", e);
  }

  // Tell the team + fire quote_accepted automations.
  await notifyUsers(supabase, {
    userIds: "all",
    title: "Quote accepted 🎉",
    body: `${quote.customer_name} signed ${quote.quote_number} — ${quote.currency} ${Number(quote.grand_total).toLocaleString()}`,
    link: "/invoices?tab=quotes",
  });

  await fireAutomationTrigger(supabase, {
    trigger: "quote_accepted",
    lead,
    // The client rides the event so every recipe step that creates a project,
    // an invoice or a payment plan lands it on the right record.
    client: client
      ? { id: client.id, name: client.name, email: client.email, phone: client.phone }
      : null,
    payload: {
      name: quote.customer_name,
      phone: quote.customer_phone,
      email: quote.customer_email,
      quote_id: quote.id,
      quote_number: quote.quote_number,
      amount: `${quote.currency} ${Number(quote.grand_total).toLocaleString()}`,
    },
    triggerKey: `${quote.id}:accepted`,
  });

  return { ok: true };
}

export async function declineQuote(input: {
  token: string;
  reason?: string;
}): Promise<ActionResult> {
  const busy = await quoteLimit(input.token);
  if (busy) return { ok: false, error: busy };

  const supabase = createAdminClient();
  const { data: quote } = await supabase
    .from("quotes")
    .select("id, status, lead_id, quote_number, customer_name, currency, grand_total")
    .eq("share_token", input.token)
    .maybeSingle();
  if (!quote) return { ok: false, error: "This quote no longer exists." };
  if (quote.status === "accepted")
    return { ok: false, error: "This quote is already accepted." };

  const reason = input.reason?.trim() || null;
  const { error } = await supabase
    .from("quotes")
    .update({
      status: "declined",
      declined_at: new Date().toISOString(),
      declined_reason: reason,
    })
    .eq("id", quote.id);
  if (error) return { ok: false, error: error.message };

  // A decline is a STRONGER signal than a view, and it used to vanish
  // silently: nobody was told, and the agent never knew. Tell the team —
  // the reason is the single most valuable line in the whole deal.
  await notifyUsers(supabase, {
    userIds: "all",
    title: "Quote declined",
    body: `${quote.customer_name} declined ${quote.quote_number} (${quote.currency} ${Number(quote.grand_total).toLocaleString()})${reason ? ` — "${reason}"` : ""}`,
    link: "/invoices?tab=quotes",
  });

  // Arm the WhatsApp agent's rescue touch (~10 min): the declined DEAL
  // STATE line puts it in recovery mode — acknowledge, isolate the real
  // objection, offer ONE revised direction. Same guards as the view nudge.
  if (quote.lead_id) {
    const { data: contact } = await supabase
      .from("wa_contacts")
      .select("id, agent_enabled, do_not_contact, needs_attention, next_followup_at")
      .eq("lead_id", quote.lead_id)
      .maybeSingle();
    if (contact?.agent_enabled && !contact.do_not_contact && !contact.needs_attention) {
      const rescue = new Date();
      rescue.setMinutes(rescue.getMinutes() + 10);
      const rescueAt = rescue.toISOString();
      if (!contact.next_followup_at || contact.next_followup_at > rescueAt) {
        await supabase
          .from("wa_contacts")
          .update({ next_followup_at: rescueAt })
          .eq("id", contact.id);
      }
    }
  }

  return { ok: true };
}
