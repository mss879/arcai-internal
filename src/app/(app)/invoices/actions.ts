"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import type { InvoiceItem } from "@/lib/database.types";
import type { ActionResult } from "@/lib/types";

export type SaveInvoiceInput = {
  invoice_number: string;
  invoice_date: string; // ISO YYYY-MM-DD
  bill_to_name: string;
  bill_to_details: string;
  items: InvoiceItem[];
  grand_total: number;
  due_today: number;
  stamp?: string | null;
};

export async function saveInvoice(
  input: SaveInvoiceInput,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  if (!input.invoice_number?.trim()) {
    return { ok: false, error: "Invoice number is required." };
  }
  if (!input.invoice_date) {
    return { ok: false, error: "Invoice date is required." };
  }

  const { data: inserted, error } = await supabase
    .from("invoices")
    .insert({
      invoice_number: input.invoice_number.trim(),
      invoice_date: input.invoice_date,
      bill_to_name: input.bill_to_name.trim(),
      bill_to_details: input.bill_to_details,
      items: input.items,
      grand_total: input.grand_total,
      due_today: input.due_today,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };

  // Best-effort: persist the "paid" stamp so the saved invoice re-downloads
  // with it. Kept separate from the insert so saving still works if the
  // 0024 migration (which adds the `stamp` column) hasn't been applied yet.
  if (input.stamp && inserted?.id) {
    try {
      await supabase
        .from("invoices")
        .update({ stamp: input.stamp })
        .eq("id", inserted.id);
    } catch {
      // ignore — stamping the saved copy is non-critical
    }
  }

  revalidatePath("/invoices");
  return { ok: true };
}

export async function deleteInvoice(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase.from("invoices").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/invoices");
  return { ok: true };
}
