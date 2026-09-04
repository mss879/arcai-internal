"use server";

import { headers } from "next/headers";

import { STORAGE_BUCKETS } from "@/lib/constants";
import { logDeliveryEvent } from "@/lib/delivery";
import { notifyUsers } from "@/lib/notify";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ActionResult } from "@/lib/types";

/**
 * Signing an agreement (0117). Public — the share token is the credential.
 *
 * Signing does three things beyond flipping a status: it renders the signed
 * PDF and files it, so both sides keep the same artefact; it writes a line on
 * the project's history when the agreement belongs to one; and it fires
 * `agreement_signed` so a recipe can start the work. The PDF is best-effort —
 * a storage hiccup must never leave a signature unrecorded.
 */

async function agreementLimit(token: string): Promise<string | null> {
  const res = await enforceRateLimit(createAdminClient(), `agreement:${token}`, {
    limit: 20,
    windowSec: 600,
  });
  return res.ok ? null : "Too many attempts. Give it a minute.";
}

async function signerIp(): Promise<string | null> {
  const headerList = await headers();
  return (
    headerList.get("x-nf-client-connection-ip")?.trim() ??
    headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    headerList.get("x-real-ip") ??
    null
  );
}

export async function signAgreement(input: {
  token: string;
  signedName: string;
  signatureData: string;
  email?: string;
}): Promise<ActionResult> {
  if (!input.signedName.trim())
    return { ok: false, error: "Please type your full name." };
  if (!input.signatureData)
    return { ok: false, error: "Please draw your signature." };

  const busy = await agreementLimit(input.token);
  if (busy) return { ok: false, error: busy };

  const supabase = createAdminClient();
  const { data: agreement } = await supabase
    .from("agreements")
    .select("*")
    .eq("share_token", input.token)
    .maybeSingle();
  if (!agreement) return { ok: false, error: "This agreement no longer exists." };
  if (agreement.status === "signed")
    return { ok: false, error: "This agreement is already signed." };
  if (agreement.status === "void")
    return { ok: false, error: "This agreement has been withdrawn." };

  const signedAt = new Date().toISOString();
  const ip = await signerIp();

  const { error } = await supabase
    .from("agreements")
    .update({
      status: "signed",
      signed_name: input.signedName.trim(),
      signature_data: input.signatureData,
      signer_email: input.email?.trim() || agreement.signer_email,
      signed_ip: ip,
      signed_at: signedAt,
    })
    .eq("id", agreement.id);
  if (error) return { ok: false, error: error.message };

  // File the signed copy. Best-effort: the signature is already recorded.
  try {
    const { renderAgreementPdf } = await import("@/lib/agreement-pdf");
    const pdf = await renderAgreementPdf({
      kind: agreement.kind,
      title: agreement.title,
      bodyMd: agreement.body_md,
      clientName: agreement.signed_name ?? input.signedName.trim(),
      date: agreement.created_at.slice(0, 10),
      signedName: input.signedName.trim(),
      signatureData: input.signatureData,
      signedAt,
      signedIp: ip,
    });
    const path = `agreements/${agreement.id}.pdf`;
    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKETS.projectDocs)
      .upload(path, pdf, { contentType: "application/pdf", upsert: true });
    if (!uploadError) {
      await supabase.from("agreements").update({ pdf_path: path }).eq("id", agreement.id);
    }
  } catch (e) {
    console.error("[agreement] signed PDF could not be filed:", e);
  }

  if (agreement.project_id) {
    try {
      await logDeliveryEvent(
        supabase,
        agreement.project_id,
        "client_note",
        `${input.signedName.trim()} signed "${agreement.title}"`,
        "client",
        { agreement_id: agreement.id, kind: agreement.kind },
      );
    } catch {
      // History is a nicety; the signature is the thing.
    }
  }

  await notifyUsers(supabase, {
    userIds: "all",
    title: "Agreement signed ✍️",
    body: `${input.signedName.trim()} signed "${agreement.title}".`,
    link: "/agreements",
  });

  // The trigger is fired through the automation engine's own event shape, so
  // a recipe can start the work the moment the ink is dry.
  try {
    const { fireAutomationTrigger } = await import("@/lib/automation");
    const lead = agreement.lead_id
      ? (await supabase.from("leads").select("*").eq("id", agreement.lead_id).maybeSingle())
          .data
      : null;
    await fireAutomationTrigger(supabase, {
      trigger: "agreement_signed",
      lead,
      payload: {
        agreement_id: agreement.id,
        title: agreement.title,
        kind: agreement.kind,
        signed_name: input.signedName.trim(),
      },
      triggerKey: `${agreement.id}:signed`,
    });
  } catch (e) {
    console.error("[agreement] trigger failed:", e);
  }

  return { ok: true };
}

export async function declineAgreement(input: {
  token: string;
  reason?: string;
}): Promise<ActionResult> {
  const busy = await agreementLimit(input.token);
  if (busy) return { ok: false, error: busy };

  const supabase = createAdminClient();
  const { data: agreement } = await supabase
    .from("agreements")
    .select("id, status, title")
    .eq("share_token", input.token)
    .maybeSingle();
  if (!agreement) return { ok: false, error: "This agreement no longer exists." };
  if (agreement.status === "signed")
    return { ok: false, error: "This agreement is already signed." };

  const reason = input.reason?.trim() || null;
  const { error } = await supabase
    .from("agreements")
    .update({
      status: "declined",
      declined_at: new Date().toISOString(),
      declined_reason: reason,
    })
    .eq("id", agreement.id);
  if (error) return { ok: false, error: error.message };

  await notifyUsers(supabase, {
    userIds: "all",
    title: "Agreement declined",
    body: `"${agreement.title}" was declined${reason ? ` — "${reason}"` : ""}.`,
    link: "/agreements",
  });

  return { ok: true };
}
