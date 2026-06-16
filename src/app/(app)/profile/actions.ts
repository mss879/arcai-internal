"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/database.types";
import type { ActionResult } from "@/lib/types";

type ProfileUpdate = Database["public"]["Tables"]["profiles"]["Update"];

export async function updateProfile(input: {
  full_name?: string;
  title?: string;
  avatar_url?: string | null;
}): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const patch: ProfileUpdate = {};
  if (input.full_name !== undefined) patch.full_name = input.full_name.trim();
  if (input.title !== undefined) patch.title = input.title.trim() || null;
  if (input.avatar_url !== undefined) patch.avatar_url = input.avatar_url;

  const { error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", user.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/profile");
  return { ok: true };
}

export async function changePassword(
  newPassword: string,
): Promise<ActionResult> {
  if (newPassword.length < 8) {
    return { ok: false, error: "Password must be at least 8 characters." };
  }
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
