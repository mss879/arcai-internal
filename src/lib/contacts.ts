import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { normalizePhone } from "@/lib/sms-utils";

type DB = SupabaseClient<Database>;

/**
 * Finding the client behind a phone number or an email (0112).
 *
 * Quotes, WhatsApp contacts and public bookings all arrive with a phone and
 * maybe an email, and until now none of them could find the client record
 * those belong to — the same person ended up as a client, a lead and a
 * WhatsApp contact that never met. `clients.phone_norm` (0112) is the
 * normalised copy the lookup runs against, so this is one indexed read.
 */

export type ClientMatch = { id: string; name: string; phone: string | null; email: string | null };

export async function findClientByPhoneOrEmail(
  supabase: DB,
  input: { phone?: string | null; email?: string | null },
): Promise<ClientMatch | null> {
  const phone = input.phone ? normalizePhone(input.phone) : null;
  if (phone?.ok) {
    const { data } = await supabase
      .from("clients")
      .select("id, name, phone, email")
      .eq("phone_norm", phone.value)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (data) return data;
  }
  const email = input.email?.trim().toLowerCase();
  if (email) {
    const { data } = await supabase
      .from("clients")
      .select("id, name, phone, email")
      .ilike("email", email)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (data) return data;
  }
  return null;
}

/**
 * The client for a person we now have a deal with — found by phone or email,
 * or created from what the document says about them. Never creates a
 * duplicate for a number we already know.
 */
export async function resolveOrCreateClient(
  supabase: DB,
  input: {
    name: string;
    phone?: string | null;
    email?: string | null;
    company?: string | null;
    city?: string | null;
    createdBy?: string | null;
  },
): Promise<{ client: ClientMatch; created: boolean } | { error: string }> {
  const existing = await findClientByPhoneOrEmail(supabase, input);
  if (existing) return { client: existing, created: false };

  const name = input.name.trim();
  if (!name) return { error: "A client needs a name." };

  const { data, error } = await supabase
    .from("clients")
    .insert({
      name,
      company: input.company?.trim() || null,
      email: input.email?.trim() || null,
      phone: input.phone?.trim() || null,
      city: input.city?.trim() || null,
      status: "active",
      created_by: input.createdBy ?? null,
    })
    .select("id, name, phone, email")
    .single();
  if (error || !data) return { error: error?.message ?? "Couldn't create the client." };
  return { client: data, created: true };
}
