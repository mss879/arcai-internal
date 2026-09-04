"use server";

import { revalidatePath } from "next/cache";

import { getProfile } from "@/lib/auth";
import { sendAndLogEmail } from "@/lib/email-outbox";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

/**
 * Raising and sending an agreement (0117).
 *
 * Deliberately thin: an agreement is a title, some Markdown and who it is
 * with. The signing side lives under /a and does the interesting work.
 */

export type AgreementInput = {
  id?: string | null;
  kind: "contract" | "sow" | "nda" | "custom";
  title: string;
  bodyMd: string;
  clientId?: string | null;
  leadId?: string | null;
  projectId?: string | null;
  proposalId?: string | null;
  signerEmail?: string | null;
};

export async function saveAgreement(
  input: AgreementInput,
): Promise<ActionResult<{ id: string }>> {
  const profile = await getProfile();
  if (!profile) return { ok: false, error: "Not signed in." };

  const title = input.title.trim();
  if (!title) return { ok: false, error: "Give it a title." };
  if (!input.bodyMd.trim()) return { ok: false, error: "The agreement is empty." };

  const supabase = await createClient();
  const row = {
    kind: input.kind,
    title,
    body_md: input.bodyMd,
    client_id: input.clientId || null,
    lead_id: input.leadId || null,
    project_id: input.projectId || null,
    proposal_id: input.proposalId || null,
    signer_email: input.signerEmail?.trim() || null,
  };

  if (input.id) {
    // A signed agreement is evidence — editing the words afterwards would
    // make the signature meaningless.
    const { data: existing } = await supabase
      .from("agreements")
      .select("status")
      .eq("id", input.id)
      .maybeSingle();
    if (existing?.status === "signed") {
      return { ok: false, error: "This one is signed — raise a new agreement instead." };
    }
    const { error } = await supabase.from("agreements").update(row).eq("id", input.id);
    if (error) return { ok: false, error: error.message };
    revalidatePath("/agreements");
    return { ok: true, id: input.id };
  }

  const { data, error } = await supabase
    .from("agreements")
    .insert({ ...row, created_by: profile.id })
    .select("id")
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not save the agreement." };
  }
  revalidatePath("/agreements");
  return { ok: true, id: data.id };
}

/** Email the signing link, and mark it sent. */
export async function sendAgreement(
  id: string,
  to: string,
  shareUrl: string,
): Promise<ActionResult> {
  const profile = await getProfile();
  if (!profile) return { ok: false, error: "Not signed in." };

  const supabase = await createClient();
  const { data: agreement } = await supabase
    .from("agreements")
    .select("id, title, kind, client_id, lead_id, project_id")
    .eq("id", id)
    .maybeSingle();
  if (!agreement) return { ok: false, error: "Agreement not found." };

  const res = await sendAndLogEmail(supabase, {
    to,
    kind: "compose",
    sentBy: profile.id,
    clientId: agreement.client_id,
    leadId: agreement.lead_id,
    projectId: agreement.project_id,
    message: {
      transport: "generic",
      subject: agreement.title,
      body: `Please find the ${agreement.kind} below for your review.\nYou can read it and sign it online — it only takes a minute.`,
      cta: { href: shareUrl, label: "Read & sign" },
    },
  });
  if (!res.sent) return { ok: false, error: res.error || "The email didn't send." };

  await supabase
    .from("agreements")
    .update({ status: "sent", sent_at: new Date().toISOString(), signer_email: to })
    .eq("id", id);

  revalidatePath("/agreements");
  return { ok: true };
}

/** Withdraw an unsigned agreement. Signed ones are never deleted. */
export async function voidAgreement(id: string): Promise<ActionResult> {
  const profile = await getProfile();
  if (!profile) return { ok: false, error: "Not signed in." };

  const supabase = await createClient();
  const { data: agreement } = await supabase
    .from("agreements")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (agreement?.status === "signed") {
    return { ok: false, error: "A signed agreement can't be withdrawn." };
  }

  const { error } = await supabase
    .from("agreements")
    .update({ status: "void" })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/agreements");
  return { ok: true };
}

/** A signed PDF, as a short-lived link. */
export async function agreementPdfUrl(id: string): Promise<string | null> {
  const profile = await getProfile();
  if (!profile) return null;
  const supabase = await createClient();
  const { data } = await supabase
    .from("agreements")
    .select("pdf_path")
    .eq("id", id)
    .maybeSingle();
  if (!data?.pdf_path) return null;
  const { data: signed } = await supabase.storage
    .from("project-docs")
    .createSignedUrl(data.pdf_path, 300);
  return signed?.signedUrl ?? null;
}
