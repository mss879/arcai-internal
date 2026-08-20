"use server";

import { revalidatePath } from "next/cache";
import { nanoid } from "nanoid";

import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { sendInviteEmail } from "@/lib/email";
import { normalizePhone } from "@/lib/sms-utils";
import type {
  ActionResult,
  LoginSession,
  MemberChange,
  UserRole,
} from "@/lib/types";
import type { Database } from "@/lib/database.types";

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

/**
 * Update another member's profile details. Admin only — members edit their
 * own details on /profile. The phone number powers SMS alerts, so it's
 * normalized to the Notify.lk format before saving.
 */
export async function updateMemberProfile(
  userId: string,
  input: { full_name?: string; title?: string; phone?: string },
): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();

  const patch: Database["public"]["Tables"]["profiles"]["Update"] = {};
  if (input.full_name !== undefined) {
    if (!input.full_name.trim())
      return { ok: false, error: "Name can't be empty." };
    patch.full_name = input.full_name.trim();
  }
  if (input.title !== undefined) patch.title = input.title.trim() || null;
  if (input.phone !== undefined) {
    if (!input.phone.trim()) {
      patch.phone = null;
    } else {
      const phone = normalizePhone(input.phone);
      if (!phone.ok) return { ok: false, error: phone.error };
      patch.phone = phone.value;
    }
  }

  const { error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", userId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/team");
  return { ok: true };
}

/**
 * A member's activity for the admin Activity view, last 30 days: every
 * sign-in (time, device, IP, location) and every change they made
 * (creates/updates/deletes captured by the member_changes audit trigger),
 * newest first. The Analytics tab is computed client-side from both.
 */
export async function getMemberActivity(
  userId: string,
): Promise<
  ActionResult<{ sessions: LoginSession[]; changes: MemberChange[] }>
> {
  await requireAdmin();
  const supabase = await createClient();
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - 30);
  const since = sinceDate.toISOString();

  const [sessionsRes, changesRes] = await Promise.all([
    supabase
      .from("login_sessions")
      .select("*")
      .eq("user_id", userId)
      .gte("logged_in_at", since)
      .order("logged_in_at", { ascending: false })
      .limit(300),
    supabase
      .from("member_changes")
      .select("*")
      .eq("user_id", userId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1000),
  ]);
  if (sessionsRes.error) return { ok: false, error: sessionsRes.error.message };
  // Changes degrade gracefully while migration 0081 isn't applied yet.
  const changes = changesRes.error
    ? []
    : ((changesRes.data ?? []) as MemberChange[]);
  return {
    ok: true,
    sessions: (sessionsRes.data ?? []) as LoginSession[],
    changes,
  };
}

/**
 * Wipe a member's trusted devices AND their 48h registration window.
 * They can then sign in from anywhere again and get a fresh 48 hours to
 * register new devices. Admin only — members can never remove devices.
 */
export async function resetMemberDevices(userId: string): Promise<ActionResult> {
  await requireAdmin();
  const svc = createAdminClient();
  const { error: devicesError } = await svc
    .from("trusted_devices")
    .delete()
    .eq("user_id", userId);
  if (devicesError) return { ok: false, error: devicesError.message };
  const { error: graceError } = await svc
    .from("device_grace")
    .delete()
    .eq("user_id", userId);
  if (graceError) return { ok: false, error: graceError.message };
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
