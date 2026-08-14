"use server";

import { headers } from "next/headers";

import { createAdminClient } from "@/lib/supabase/admin";
import { fireAutomationTrigger } from "@/lib/automation";
import { sendPushToUser } from "@/lib/push";
import type { ActionResult } from "@/lib/types";

/**
 * Public quote actions (no auth — the share token is the credential).
 * Uses the admin client because the visitor has no Supabase session.
 */

export async function acceptQuote(input: {
  token: string;
  signedName: string;
  signatureData: string;
}): Promise<ActionResult> {
  if (!input.signedName.trim())
    return { ok: false, error: "Please type your full name." };
  if (!input.signatureData)
    return { ok: false, error: "Please draw your signature." };

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

  // Tell the team + fire quote_accepted automations.
  const { data: profiles } = await supabase.from("profiles").select("id");
  for (const p of profiles ?? []) {
    await supabase.from("notifications").insert({
      user_id: p.id,
      type: "system",
      title: "Quote accepted 🎉",
      body: `${quote.customer_name} signed ${quote.quote_number} — ${quote.currency} ${Number(quote.grand_total).toLocaleString()}`,
      link: "/invoices?tab=quotes",
    });
    await sendPushToUser({
      userId: p.id,
      title: "Quote accepted 🎉",
      body: `${quote.customer_name} signed ${quote.quote_number}`,
      link: "/invoices?tab=quotes",
    });
  }

  const lead = quote.lead_id
    ? (await supabase.from("leads").select("*").eq("id", quote.lead_id).single()).data
    : null;
  await fireAutomationTrigger(supabase, {
    trigger: "quote_accepted",
    lead,
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
  const { data: profiles } = await supabase.from("profiles").select("id");
  for (const p of profiles ?? []) {
    await supabase.from("notifications").insert({
      user_id: p.id,
      type: "system",
      title: "Quote declined",
      body: `${quote.customer_name} declined ${quote.quote_number} (${quote.currency} ${Number(quote.grand_total).toLocaleString()})${reason ? ` — "${reason}"` : ""}`,
      link: "/invoices?tab=quotes",
    });
    await sendPushToUser({
      userId: p.id,
      title: "Quote declined",
      body: `${quote.customer_name} declined ${quote.quote_number}${reason ? ` — "${reason}"` : ""}`,
      link: "/invoices?tab=quotes",
    });
  }

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
