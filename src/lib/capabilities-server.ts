import "server-only";

import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

import { hasCapability, type Capability } from "@/lib/capabilities";
import type { Database } from "@/lib/database.types";
import { createAdminClient } from "@/lib/supabase/admin";

type DB = SupabaseClient<Database>;

/**
 * The server half of capabilities (T5.2).
 *
 * Everything here reads through the service-role client on purpose: the
 * enforcement switch lives in `app_settings`, which RLS does not open to a
 * member, and a switch a member's own client cannot read would silently
 * read as "off" for exactly the people it is meant to govern.
 */

/** `app_settings.capabilities_enforced.enabled`. Off until an admin turns it on. */
export const capabilitiesEnforced = cache(async (): Promise<boolean> => {
  try {
    const { data } = await createAdminClient()
      .from("app_settings")
      .select("value")
      .eq("key", "capabilities_enforced")
      .maybeSingle();
    return (data?.value as { enabled?: boolean } | null)?.enabled === true;
  } catch {
    return false;
  }
});

/**
 * May this actor do a `capability` thing, right now?
 *
 * For code that carries an `actorId` rather than a request — recordPayment()
 * is the reason this exists. Passes while enforcement is off, for a system
 * actor (null), and for an admin; refuses a member without the tick.
 */
export async function actorHasCapability(
  db: DB,
  actorId: string | null | undefined,
  capability: Capability,
): Promise<boolean> {
  if (!actorId) return true;
  if (!(await capabilitiesEnforced())) return true;
  const { data, error } = await db
    .from("profiles")
    .select("id, role, capabilities")
    .eq("id", actorId)
    .maybeSingle();
  if (error) {
    // 0121 not applied — the column is not there to enforce.
    const { data: bare } = await db.from("profiles").select("id, role").eq("id", actorId).maybeSingle();
    return Boolean(bare);
  }
  if (!data) return false;
  return hasCapability(data, capability);
}

/**
 * Everyone who should hear about a `capability` event — admins plus the
 * members ticked for it. Admins alone on a database without 0121.
 */
export async function capabilityAudienceIds(capability: Capability): Promise<string[]> {
  const admin = createAdminClient();
  try {
    const { data, error } = await admin.from("profiles").select("id, role, capabilities");
    if (error) throw error;
    return (data ?? []).filter((p) => hasCapability(p, capability)).map((p) => p.id);
  } catch {
    const { data } = await admin.from("profiles").select("id").eq("role", "admin");
    return (data ?? []).map((p) => p.id);
  }
}
