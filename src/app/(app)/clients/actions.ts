"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth";
import { fireAutomationTrigger } from "@/lib/automation";
import { eraseClient, type EraseMode } from "@/lib/client-erasure";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult, ClientStatus } from "@/lib/types";

export type ClientInput = {
  id?: string;
  name: string;
  company?: string;
  email?: string;
  phone?: string;
  city?: string;
  status?: ClientStatus;
  notes?: string;
};

export async function saveClient(input: ClientInput): Promise<ActionResult<{ client?: any }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!input.name?.trim()) return { ok: false, error: "Name is required." };

  const payload = {
    name: input.name.trim(),
    company: input.company?.trim() || null,
    email: input.email?.trim() || null,
    phone: input.phone?.trim() || null,
    city: input.city?.trim() || null,
    status: input.status ?? "active",
    notes: input.notes?.trim() || null,
  };

  const query = input.id
    ? supabase.from("clients").update(payload).eq("id", input.id)
    : supabase.from("clients").insert(payload);

  const { data, error } = await query.select().single();

  if (error) return { ok: false, error: error.message };

  // 0085 — client_created was declared since 0032 but never fired anywhere;
  // the delivery suite's welcome recipe finally listens for it.
  if (!input.id && data) {
    await fireAutomationTrigger(supabase, {
      trigger: "client_created",
      client: {
        id: data.id,
        name: data.name,
        email: data.email,
        phone: data.phone,
      },
      payload: { name: data.name, phone: data.phone, email: data.email },
      triggerKey: `${data.id}:created`,
    });
  }

  revalidatePath("/clients");
  return { ok: true, client: data };
}

/**
 * T5.7 — "delete" from the list is an erasure: admin-only, refused once
 * money exists (anonymise from the client's page instead), and it scrubs
 * the person's data from every conversation before the row goes.
 */
export async function deleteClient(id: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  const supabase = await createClient();
  const res = await eraseClient(supabase, id, "delete", { actorId: admin.id });
  if (!res.ok) return res;
  revalidatePath("/clients");
  return { ok: true };
}

/**
 * The right to be forgotten, with the person's name typed to confirm.
 * Anonymise keeps the row (and the money); delete removes it and is only
 * possible when nothing was ever invoiced or paid.
 */
export async function eraseClientAction(
  id: string,
  input: { mode: EraseMode; confirmName: string },
): Promise<ActionResult<{ mode: EraseMode; touched: Record<string, number> }>> {
  const admin = await requireAdmin();
  const supabase = await createClient();
  const { data: client } = await supabase.from("clients").select("id, name").eq("id", id).maybeSingle();
  if (!client) return { ok: false, error: "That client no longer exists." };
  if (input.confirmName.trim().toLowerCase() !== client.name.trim().toLowerCase()) {
    return { ok: false, error: "Type the client's name exactly as it appears to confirm." };
  }
  const res = await eraseClient(supabase, id, input.mode, { actorId: admin.id });
  if (!res.ok) return res;
  revalidatePath("/clients");
  revalidatePath(`/clients/${id}`);
  return { ok: true, mode: res.mode, touched: res.touched };
}
