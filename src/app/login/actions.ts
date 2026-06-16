"use server";

import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/auth";

export type AuthState = { error?: string } | undefined;

function safePath(input: string, fallback = "/dashboard") {
  return input.startsWith("/") && !input.startsWith("//") ? input : fallback;
}

/** Sign in with username OR email + password. */
export async function loginAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  if (!isSupabaseConfigured()) {
    return { error: "Supabase is not configured yet. Add your keys to .env.local." };
  }

  const identifier = String(formData.get("identifier") || "").trim();
  const password = String(formData.get("password") || "");
  const redirectTo = safePath(String(formData.get("redirectTo") || "/dashboard"));

  if (!identifier || !password) {
    return { error: "Enter your username/email and password." };
  }

  let email = identifier;

  // Resolve a username to its email using the privileged client.
  if (!identifier.includes("@")) {
    try {
      const admin = createAdminClient();
      const { data } = await admin
        .from("profiles")
        .select("email")
        .eq("username", identifier.toLowerCase())
        .maybeSingle();
      if (!data?.email) {
        return { error: "No account found with that username." };
      }
      email = data.email;
    } catch {
      return { error: "Unable to resolve username — try your email instead." };
    }
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return { error: "Invalid credentials. Please try again." };
  }

  redirect(redirectTo);
}

/** Sign the current user out. */
export async function signOutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
