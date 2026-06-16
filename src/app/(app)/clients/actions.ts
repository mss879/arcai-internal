"use server";

import { revalidatePath } from "next/cache";

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

  revalidatePath("/clients");
  return { ok: true, client: data };
}

export async function deleteClient(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("clients").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/clients");
  return { ok: true };
}
