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
    .select("id, status")
    .eq("share_token", input.token)
    .maybeSingle();
  if (!quote) return { ok: false, error: "This quote no longer exists." };
  if (quote.status === "accepted")
    return { ok: false, error: "This quote is already accepted." };

  const { error } = await supabase
    .from("quotes")
    .update({
      status: "declined",
      declined_at: new Date().toISOString(),
      declined_reason: input.reason?.trim() || null,
    })
    .eq("id", quote.id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
