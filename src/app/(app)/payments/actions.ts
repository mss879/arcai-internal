"use server";

import { revalidatePath } from "next/cache";

import { fireAutomationTrigger } from "@/lib/automation";
import { buildPaymentEvent } from "@/lib/delivery";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

export type CompanyPaymentInput = {
  company_name: string;
  price_lkr: number;
  status: "pending" | "upcoming";
  /** The project this payment settles (0083). Null = a standalone payment. */
  project_id?: string | null;
};

export async function createCompanyPayment(
  input: CompanyPaymentInput,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!input.company_name?.trim()) return { ok: false, error: "Company name is required." };
  if (typeof input.price_lkr !== "number" || isNaN(input.price_lkr) || input.price_lkr < 0) {
    return { ok: false, error: "Price must be a valid positive number." };
  }
  if (input.status !== "pending" && input.status !== "upcoming") {
    return { ok: false, error: "Invalid payment status." };
  }

  const { error } = await supabase.from("company_payments").insert({
    company_name: input.company_name.trim(),
    price_lkr: input.price_lkr,
    status: input.status,
    project_id: input.project_id || null,
  });

  if (error) return { ok: false, error: error.message };
  revalidatePath("/payments");
  // A linked payment moves the project's balance — refresh that board too.
  if (input.project_id) revalidatePath("/projects");
  return { ok: true };
}

export async function toggleCompanyPaymentPaid(
  id: string,
  isPaid: boolean,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  // Read before write: firing payment_received needs the project link and
  // whether this is genuinely a false→true flip (not a re-save).
  const { data: prior } = await supabase
    .from("company_payments")
    .select("id, price_lkr, project_id, is_paid")
    .eq("id", id)
    .maybeSingle();

  const { error } = await supabase
    .from("company_payments")
    .update({ is_paid: isPaid })
    .eq("id", id);

  if (error) return { ok: false, error: error.message };

  // 0085 — a project-linked payment flipping to PAID is the delivery
  // system's cue (the "Payment received → full client onboarding" recipe
  // filters on first_payment). The triggerKey makes un-tick/re-tick safe.
  if (isPaid && prior && !prior.is_paid && prior.project_id) {
    const event = await buildPaymentEvent(supabase, {
      projectId: prior.project_id,
      amountText: `LKR ${Number(prior.price_lkr).toLocaleString()}`,
      source: "payments_board",
      triggerKey: `company_payment:${id}:paid`,
    });
    if (event) await fireAutomationTrigger(supabase, event);
  }

  revalidatePath("/payments");
  // Paid/unpaid is what the project balance counts — keep that board honest.
  revalidatePath("/projects");
  return { ok: true };
}

export async function deleteCompanyPayment(
  id: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase.from("company_payments").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/payments");
  revalidatePath("/projects");
  return { ok: true };
}
