"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth";
import type { SocialPlatform } from "@/lib/database.types";
import { encryptToken, isSocialCryptoConfigured } from "@/lib/social/crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ActionResult } from "@/lib/types";

/**
 * The settings hub's own writes (T5.1). Admin-only, every one.
 *
 * Three tables are touched, and each is written through the service-role
 * client on purpose: `app_settings` and `social_accounts` are read-restricted
 * to admins by RLS and `document_counters` has no policies at all (only
 * `next_document_number()` touches it). `requireAdmin()` is the gate; the
 * client below is the key.
 */

const SETTING_KEYS = ["lead_form", "outreach", "web_chat_auto_lead", "capabilities_enforced"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** Replace one `app_settings` value. The shape is the reader's business. */
export async function saveAppSetting(
  key: SettingKey,
  value: Record<string, unknown>,
): Promise<ActionResult> {
  await requireAdmin();
  if (!SETTING_KEYS.includes(key)) return { ok: false, error: "Not a setting this page owns." };

  const admin = createAdminClient();
  const { error } = await admin
    .from("app_settings")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true };
}

// ---- Social accounts (0118) -------------------------------------------------

export type ConnectSocialAccountInput = {
  platform: SocialPlatform;
  name: string;
  external_id: string;
  page_id?: string | null;
  /** The long-lived Page / IG token. Encrypted before it is stored. */
  access_token: string;
  token_expires_at?: string | null;
  client_id?: string | null;
};

/**
 * Connect an Instagram or Facebook account for publishing.
 *
 * Until now no row could reach `social_accounts` at all — the publisher
 * read a table nothing wrote. The token goes through `encryptToken()` and
 * never sits in the clear; without SOCIAL_TOKEN_KEY the form refuses rather
 * than storing something the publisher could never decrypt.
 */
export async function connectSocialAccount(
  input: ConnectSocialAccountInput,
): Promise<ActionResult<{ id: string }>> {
  const profile = await requireAdmin();
  if (!isSocialCryptoConfigured()) {
    return {
      ok: false,
      error: "SOCIAL_TOKEN_KEY isn't set on the server, so a token can't be stored safely. Add it first.",
    };
  }
  if (input.platform !== "instagram" && input.platform !== "facebook") {
    return { ok: false, error: "Pick Instagram or Facebook." };
  }
  const name = input.name.trim();
  const externalId = input.external_id.trim();
  const token = input.access_token.trim();
  if (!name) return { ok: false, error: "Give the account a name." };
  if (!externalId) return { ok: false, error: "The account id from Meta is required." };
  if (!token) return { ok: false, error: "Paste the access token." };
  if (input.platform === "instagram" && !input.page_id?.trim()) {
    return { ok: false, error: "Instagram publishes through its linked Facebook Page — enter the Page id." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("social_accounts")
    .upsert(
      {
        platform: input.platform,
        name,
        external_id: externalId,
        page_id: input.page_id?.trim() || null,
        access_token_enc: encryptToken(token),
        token_expires_at: input.token_expires_at || null,
        client_id: input.client_id || null,
        active: true,
        created_by: profile.id,
      },
      { onConflict: "platform,external_id" },
    )
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "Could not save the account." };

  revalidatePath("/settings");
  revalidatePath("/content");
  return { ok: true, id: data.id };
}

export async function setSocialAccountActive(id: string, active: boolean): Promise<ActionResult> {
  await requireAdmin();
  const admin = createAdminClient();
  const { error } = await admin.from("social_accounts").update({ active }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  revalidatePath("/content");
  return { ok: true };
}

export async function deleteSocialAccount(id: string): Promise<ActionResult> {
  await requireAdmin();
  const admin = createAdminClient();
  const { error } = await admin.from("social_accounts").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  revalidatePath("/content");
  return { ok: true };
}

// ---- Document numbering (0120) ----------------------------------------------

/**
 * Move a series forward so the NEXT number handed out is `next`.
 *
 * Forward only: a counter wound back would hand out a number that already
 * exists, which is the exact bug 0120 was written to end. The number is
 * what `next_document_number()` will return, so `last` is stored as one
 * less.
 */
export async function setNextDocumentNumber(
  kind: string,
  next: number,
): Promise<ActionResult<{ last: number }>> {
  await requireAdmin();
  if (!["invoice", "quote", "notice"].includes(kind)) {
    return { ok: false, error: "That isn't a numbered series." };
  }
  if (!Number.isInteger(next) || next < 1) {
    return { ok: false, error: "Enter a whole number." };
  }
  const admin = createAdminClient();
  const { data: current } = await admin
    .from("document_counters")
    .select("last")
    .eq("kind", kind)
    .maybeSingle();
  if (!current) return { ok: false, error: "That series has no counter yet (migration 0120)." };
  if (next <= current.last) {
    return {
      ok: false,
      error: `The series is already past ${next} — the next number must be above ${current.last}.`,
    };
  }
  const { error } = await admin
    .from("document_counters")
    .update({ last: next - 1, updated_at: new Date().toISOString() })
    .eq("kind", kind);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true, last: next - 1 };
}
