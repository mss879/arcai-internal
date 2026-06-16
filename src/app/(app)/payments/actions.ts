"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

export type CompanyPaymentInput = {
  company_name: string;
  price_lkr: number;
  status: "pending" | "upcoming";
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
  });

  if (error) return { ok: false, error: error.message };
  revalidatePath("/payments");
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

  const { error } = await supabase
    .from("company_payments")
    .update({ is_paid: isPaid })
    .eq("id", id);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/payments");
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
  return { ok: true };
}
