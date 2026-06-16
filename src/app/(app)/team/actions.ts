"use server";

import { revalidatePath } from "next/cache";
import { nanoid } from "nanoid";

import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { sendInviteEmail } from "@/lib/email";
import type { ActionResult, UserRole } from "@/lib/types";

/** Create an invitation and email a join link. Admin only. */
export async function createInvite(
  email: string,
  role: UserRole = "member",
): Promise<ActionResult<{ inviteUrl: string; emailSent: boolean }>> {
  const admin = await requireAdmin();
  const clean = email.trim().toLowerCase();
  if (!clean || !clean.includes("@")) {
    return { ok: false, error: "Enter a valid email address." };
  }

  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("profiles")
    .select("id")
    .eq("email", clean)
    .maybeSingle();
  if (existing) {
    return { ok: false, error: "That email already has an account." };
  }

  // Supersede any prior pending invite for this email.
  await supabase
    .from("invitations")
    .update({ status: "revoked" })
    .eq("email", clean)
    .eq("status", "pending");

  const token = nanoid(32);
  const { error } = await supabase.from("invitations").insert({
    email: clean,
    role,
    token,
    invited_by: admin.id,
  });
  if (error) return { ok: false, error: error.message };

  const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL || ""}/join/${token}`;
  const sent = await sendInviteEmail({
    to: clean,
    inviteUrl,
    inviterName: admin.full_name,
  });

  revalidatePath("/team");
  return { ok: true, inviteUrl, emailSent: sent.sent };
}

export async function revokeInvite(id: string): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();
  const { error } = await supabase.from("invitations").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/team");
  return { ok: true };
}

export async function updateMemberRole(
  userId: string,
  role: UserRole,
): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (userId === admin.id && role === "member") {
    return { ok: false, error: "You can't remove your own admin access." };
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ role })
    .eq("id", userId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/team");
  return { ok: true };
}

export async function removeMember(userId: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (userId === admin.id) {
    return { ok: false, error: "You can't remove yourself." };
  }
  const svc = createAdminClient();
  const { error } = await svc.auth.admin.deleteUser(userId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/team");
  return { ok: true };
}
