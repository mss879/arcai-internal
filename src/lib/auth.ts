import { cache } from "react";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { usernameFromName } from "@/lib/utils";
import type { Profile, UserRole } from "@/lib/types";

/** True when the Supabase env vars are present. */
export function isSupabaseConfigured() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

/**
 * Create a profile row for an auth user that doesn't have one yet.
 * This covers admins created directly in the Supabase dashboard, or users
 * who existed before the migrations/trigger were applied. Prevents the
 * "authenticated but no profile" redirect loop.
 */
async function ensureProfile(user: User): Promise<Profile | null> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;

  const admin = createAdminClient();
  const email = (user.email ?? "").toLowerCase();
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;

  const { count } = await admin
    .from("profiles")
    .select("*", { count: "exact", head: true });

  const adminEmail = process.env.NEXT_PUBLIC_ADMIN_EMAIL?.toLowerCase();
  const role: UserRole =
    (count ?? 0) === 0 || (adminEmail && email === adminEmail)
      ? "admin"
      : ((meta.role as UserRole) ?? "member");

  const fullName =
    (meta.full_name as string) || email.split("@")[0] || "User";
  const base = (meta.username as string) || usernameFromName(fullName);

  let username = base;
  for (let i = 1; i <= 50; i++) {
    const { data: clash } = await admin
      .from("profiles")
      .select("id")
      .eq("username", username)
      .maybeSingle();
    if (!clash) break;
    username = `${base}${i + 1}`;
  }

  const { data } = await admin
    .from("profiles")
    .insert({
      id: user.id,
      email: user.email ?? "",
      full_name: fullName,
      username,
      role,
    })
    .select("*")
    .single();

  return data ?? null;
}

/** The currently authenticated profile, or null. Self-heals a missing row. */
export const getProfile = cache(async (): Promise<Profile | null> => {
  if (!isSupabaseConfigured()) return null;

  const supabase = await createClient();

  // Fast path: validate the session JWT instead of always making a network
  // round-trip to the Supabase Auth server. This runs on *every* navigation,
  // so it dominates how fast tab switches feel. When the project uses
  // asymmetric JWT signing keys, getClaims() verifies the token signature
  // locally (no network); otherwise it transparently falls back to getUser().
  // Either way the token is fully validated (signature + expiry), so this is
  // safe — it only removes latency, it never trusts an invalid session.
  const { data: claimsData, error } = await supabase.auth.getClaims();
  const userId = claimsData?.claims?.sub;
  if (error || !userId) return null;

  const { data } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (data) return data;

  // No profile row yet — fetch the full user object to self-heal.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return ensureProfile(user);
});

/** Like getProfile but redirects to /login when not signed in. */
export async function requireProfile(): Promise<Profile> {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  return profile;
}

/** Redirects non-admins back to the dashboard. */
export async function requireAdmin(): Promise<Profile> {
  const profile = await requireProfile();
  if (profile.role !== "admin") redirect("/dashboard");
  return profile;
}
