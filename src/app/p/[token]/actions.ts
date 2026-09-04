"use server";

import { headers } from "next/headers";

import { fireAutomationTrigger } from "@/lib/automation";
import { resolveOrCreateClient } from "@/lib/contacts";
import { markLeadWon } from "@/lib/leads";
import { notifyUsers } from "@/lib/notify";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ActionResult } from "@/lib/types";

/**
 * Public proposal actions (0117). No auth — the share token is the credential,
 * exactly as on /q.
 *
 * A proposal is the bigger document of the two and could only ever be emailed
 * and chased: there was no way for a client to say yes to one. Now it is
 * signed the same way a quote is, and acceptance does the same three things —
 * resolve the client, win the lead, fire the trigger — so whichever document
 * the deal was closed on, the chain reads the same afterwards.
 */

async function proposalLimit(token: string): Promise<string | null> {
  const res = await enforceRateLimit(createAdminClient(), `proposal:${token}`, {
    limit: 20,
    windowSec: 600,
  });
  return res.ok ? null : "Too many attempts. Give it a minute.";
}

/** The signer's IP, recorded as evidence alongside the signature. */
async function signerIp(): Promise<string | null> {
  const headerList = await headers();
  return (
    headerList.get("x-nf-client-connection-ip")?.trim() ??
    headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    headerList.get("x-real-ip") ??
    null
  );
}

export async function acceptProposal(input: {
  token: string;
  signedName: string;
  signatureData: string;
}): Promise<ActionResult> {
  if (!input.signedName.trim())
    return { ok: false, error: "Please type your full name." };
  if (!input.signatureData)
    return { ok: false, error: "Please draw your signature." };

  const busy = await proposalLimit(input.token);
  if (busy) return { ok: false, error: busy };

  const supabase = createAdminClient();
  const { data: proposal } = await supabase
    .from("proposals")
    .select("*")
    .eq("share_token", input.token)
    .maybeSingle();
  if (!proposal) return { ok: false, error: "This proposal no longer exists." };
  if (proposal.status === "accepted")
    return { ok: false, error: "This proposal is already accepted." };
  if (proposal.status === "declined")
    return { ok: false, error: "This proposal was declined." };

  const { error } = await supabase
    .from("proposals")
    .update({
      status: "accepted",
      signed_name: input.signedName.trim(),
      signature_data: input.signatureData,
      signed_ip: await signerIp(),
      accepted_at: new Date().toISOString(),
    })
    .eq("id", proposal.id);
  if (error) return { ok: false, error: error.message };

  const lead = proposal.lead_id
    ? (await supabase.from("leads").select("*").eq("id", proposal.lead_id).maybeSingle())
        .data
    : null;

  // A signed proposal is a client, whatever record it started as — the same
  // rule a signed quote follows. Best-effort throughout: a hiccup here must
  // never un-accept something somebody has signed.
  let client: { id: string; name: string; email?: string | null; phone?: string | null } | null =
    null;
  try {
    const knownId = proposal.client_id ?? lead?.client_id ?? null;
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
        name: proposal.client_name,
        phone: lead?.contact_phone ?? null,
        email: lead?.contact_email ?? null,
        company: lead?.company ?? null,
      });
      if ("client" in resolved) client = resolved.client;
    }
    if (client) {
      if (!proposal.client_id)
        await supabase
          .from("proposals")
          .update({ client_id: client.id })
          .eq("id", proposal.id);
      if (lead && !lead.client_id)
        await supabase.from("leads").update({ client_id: client.id }).eq("id", lead.id);
    }
    if (lead && lead.status !== "won") await markLeadWon(supabase, lead.id);
  } catch (e) {
    console.error("[proposal] client/lead link after acceptance failed:", e);
  }

  await notifyUsers(supabase, {
    userIds: "all",
    title: "Proposal signed 🎉",
    body: `${proposal.client_name} signed the ${proposal.project_name} proposal — ${proposal.currency} ${Number(proposal.grand_total).toLocaleString()}`,
    link: "/proposals",
  });

  await fireAutomationTrigger(supabase, {
    trigger: "proposal_accepted",
    lead,
    // The client rides the event so every recipe step that creates a project
    // or an invoice lands it on the right record.
    client: client
      ? {
          id: client.id,
          name: client.name,
          email: client.email ?? null,
          phone: client.phone ?? null,
        }
      : null,
    payload: {
      proposal_id: proposal.id,
      project_name: proposal.project_name,
      name: proposal.client_name,
      amount: `${proposal.currency} ${Number(proposal.grand_total).toLocaleString()}`,
      signed_name: input.signedName.trim(),
    },
    triggerKey: `${proposal.id}:accepted`,
  });

  return { ok: true };
}

export async function declineProposal(input: {
  token: string;
  reason?: string;
}): Promise<ActionResult> {
  const busy = await proposalLimit(input.token);
  if (busy) return { ok: false, error: busy };

  const supabase = createAdminClient();
  const { data: proposal } = await supabase
    .from("proposals")
    .select("id, status, client_name, project_name")
    .eq("share_token", input.token)
    .maybeSingle();
  if (!proposal) return { ok: false, error: "This proposal no longer exists." };
  if (proposal.status === "accepted")
    return { ok: false, error: "This proposal is already accepted." };

  const reason = input.reason?.trim() || null;
  const { error } = await supabase
    .from("proposals")
    .update({
      status: "declined",
      declined_at: new Date().toISOString(),
      declined_reason: reason,
    })
    .eq("id", proposal.id);
  if (error) return { ok: false, error: error.message };

  await notifyUsers(supabase, {
    userIds: "all",
    title: "Proposal declined",
    body: `${proposal.client_name} declined the ${proposal.project_name} proposal${reason ? ` — "${reason}"` : ""}`,
    link: "/proposals",
  });

  return { ok: true };
}
