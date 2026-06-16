"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { usernameFromName } from "@/lib/utils";

export type JoinState =
  | { error?: string; success?: { email: string } }
  | undefined;

/** Accept an invite: the user provides their name + chosen password. */
export async function acceptInviteAction(
  _prev: JoinState,
  formData: FormData,
): Promise<JoinState> {
  const token = String(formData.get("token") || "");
  const fullName = String(formData.get("full_name") || "").trim();
  const password = String(formData.get("password") || "");

  if (!token) return { error: "Missing invite token." };
  if (fullName.length < 2) return { error: "Please enter your full name." };
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { error: "Server is not configured. Contact your admin." };
  }

  const admin = createAdminClient();

  const { data: invite } = await admin
    .from("invitations")
    .select("*")
    .eq("token", token)
    .maybeSingle();

  if (!invite) return { error: "This invite link is invalid." };
  if (invite.status !== "pending") {
    return { error: "This invite has already been used or was revoked." };
  }
  if (new Date(invite.expires_at) < new Date()) {
    await admin
      .from("invitations")
      .update({ status: "expired" })
      .eq("id", invite.id);
    return { error: "This invite has expired. Ask your admin for a new one." };
  }

  // Generate a unique username from the person's name (used for @mentions).
  const base = usernameFromName(fullName);
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

  const { error: createErr } = await admin.auth.admin.createUser({
    email: invite.email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: fullName,
      username,
      role: invite.role,
    },
  });

  if (createErr) {
    const already = /already|registered|exists/i.test(createErr.message);
    return {
      error: already
        ? "An account for this email already exists — try logging in."
        : createErr.message,
    };
  }

  await admin
    .from("invitations")
    .update({ status: "accepted", accepted_at: new Date().toISOString() })
    .eq("id", invite.id);

  return { success: { email: invite.email } };
}
