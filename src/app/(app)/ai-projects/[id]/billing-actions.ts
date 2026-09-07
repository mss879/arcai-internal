"use server";

import { revalidatePath } from "next/cache";

import { colomboDay, isDay, monthStart } from "@/lib/ai-projects/time-core";
import { requireAdmin } from "@/lib/auth";
import { createAiUsageInvoice } from "@/lib/invoices";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

/** The Invoices tab's actions (0126): the terms, and raising a month by hand. */

export type BillingSettingsInput = {
  enabled: boolean;
  currency: "USD" | "LKR";
  fee: number;
  markup: number;
  minimum: number;
  fx: number | null;
  mode: "draft" | "auto_send";
  billingFrom: string;
};

export async function saveBillingSettings(id: string, input: BillingSettingsInput): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();
  if (input.currency !== "USD" && input.currency !== "LKR") return { ok: false, error: "Bill in USD or LKR." };
  if (input.mode !== "draft" && input.mode !== "auto_send") return { ok: false, error: "Pick draft or auto-send." };
  const fee = Number(input.fee);
  const markup = Number(input.markup);
  const minimum = Number(input.minimum);
  if (!Number.isFinite(fee) || fee < 0) return { ok: false, error: "The monthly fee must be 0 or more." };
  if (!Number.isFinite(markup) || markup < 0 || markup > 100) return { ok: false, error: "The markup must be between 0 and 100 (1 = pass-through, 2 = double)." };
  if (!Number.isFinite(minimum) || minimum < 0) return { ok: false, error: "The minimum must be 0 or more." };
  let fx: number | null = null;
  if (input.fx != null && input.fx !== 0) {
    fx = Number(input.fx);
    if (!Number.isFinite(fx) || fx <= 0) return { ok: false, error: "The LKR rate must be a positive number of rupees per US dollar." };
  }
  if (input.currency === "LKR" && !fx && input.enabled) return { ok: false, error: "Set the LKR rate (rupees per US dollar) for an LKR project." };
  if (!isDay(input.billingFrom)) return { ok: false, error: "Pick the date billing starts." };

  const { error } = await supabase
    .from("ai_projects")
    .update({
      billing_enabled: input.enabled,
      billing_currency: input.currency,
      monthly_fee: Math.round(fee * 100) / 100,
      usage_markup: Math.round(markup * 1000) / 1000,
      monthly_minimum: Math.round(minimum * 100) / 100,
      fx_lkr_per_usd: fx,
      invoice_mode: input.mode,
      billing_from: input.billingFrom,
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/ai-projects/${id}`);
  return { ok: true };
}

export async function raiseAiInvoice(id: string, period: string): Promise<ActionResult<{ invoiceNumber: string | null; skipped: boolean; emailed: boolean; created: boolean; total: number }>> {
  const admin = await requireAdmin();
  const supabase = await createClient();
  if (!isDay(period) || monthStart(period) !== period) return { ok: false, error: "Pick a month." };
  if (period >= monthStart(colomboDay())) return { ok: false, error: "That month is still running — it can be invoiced from the 1st." };
  const res = await createAiUsageInvoice(supabase, { projectId: id, period, actorId: admin.id });
  if (!res.ok) return res;
  revalidatePath(`/ai-projects/${id}`);
  revalidatePath("/invoices");
  return { ok: true, invoiceNumber: res.invoiceNumber, skipped: res.skipped, emailed: res.emailed, created: res.created, total: res.total };
}
