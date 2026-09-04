import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { notifyUsers } from "@/lib/notify";

type DB = SupabaseClient<Database>;

/**
 * Client referrals (0117).
 *
 * Word of mouth is where most of this agency's work comes from and none of it
 * was recorded: a client introduced somebody, the introduction was thanked for
 * in a WhatsApp message, and six months later nobody could say who had brought
 * whom — or that anyone was owed anything for it.
 *
 * A code is minted lazily, the first time somebody actually shares one, so an
 * existing client list doesn't fill up with codes nobody will ever use. The
 * referral itself is recorded when the LEAD arrives, not when it closes, so
 * the introduction is credited even if the deal takes months.
 */

/** No 0/O/1/I: these get read off a screen and typed into a form. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function mintCode(seed: string): string {
  // Derived from the client id rather than random, so a retry after a failed
  // write produces the same code instead of a second one.
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += ALPHABET[hash % ALPHABET.length];
    hash = Math.floor(hash / ALPHABET.length) + (i + 1) * 7919;
  }
  return `ARC-${out}`;
}

/**
 * This client's referral code, creating one if they have none.
 *
 * Returns null only when the client doesn't exist or the column isn't there
 * yet — callers treat that as "referrals aren't available", never as an error
 * worth showing anyone.
 */
export async function referralCodeFor(
  db: DB,
  clientId: string,
): Promise<string | null> {
  try {
    const { data: client } = await db
      .from("clients")
      .select("id, referral_code")
      .eq("id", clientId)
      .maybeSingle();
    if (!client) return null;
    if (client.referral_code) return client.referral_code;

    const code = mintCode(clientId);
    const { error } = await db
      .from("clients")
      .update({ referral_code: code })
      .eq("id", clientId);
    // A collision on the unique index means somebody else took this code;
    // re-read rather than inventing a second one.
    if (error) {
      const { data: again } = await db
        .from("clients")
        .select("referral_code")
        .eq("id", clientId)
        .maybeSingle();
      return again?.referral_code ?? null;
    }
    return code;
  } catch {
    return null;
  }
}

/** The link a client shares. Null when the app URL isn't configured. */
export function referralLink(code: string): string | null {
  const base = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!base) return null;
  return `https://www.arcai.agency/?ref=${encodeURIComponent(code)}`;
}

/**
 * A referred lead has been won — credit the introduction.
 *
 * Raises a task rather than paying anything: what a referrer is owed is a
 * conversation, not a formula, and this system should not guess it.
 */
export async function markReferralWon(db: DB, leadId: string): Promise<void> {
  try {
    const { data: referral } = await db
      .from("referrals")
      .select("id, code, status, referrer_client_id")
      .eq("referred_lead_id", leadId)
      .maybeSingle();
    if (!referral || referral.status !== "pending") return;

    const { data: lead } = await db
      .from("leads")
      .select("title, client_id")
      .eq("id", leadId)
      .maybeSingle();

    await db
      .from("referrals")
      .update({
        status: "won",
        won_at: new Date().toISOString(),
        referred_client_id: lead?.client_id ?? null,
      })
      .eq("id", referral.id);

    let referrerName = "A client";
    if (referral.referrer_client_id) {
      const { data: referrer } = await db
        .from("clients")
        .select("name")
        .eq("id", referral.referrer_client_id)
        .maybeSingle();
      referrerName = referrer?.name ?? referrerName;
    }

    const title = `Reward ${referrerName} for a referral`;
    await db.from("crm_tasks").insert({
      lead_id: leadId,
      title,
      notes: `${referrerName} introduced ${lead?.title ?? "this lead"} (code ${referral.code}), and it has just been won. Agree what they get, then mark the referral rewarded.`,
      due_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      created_by: null,
    });

    await notifyUsers(db, {
      userIds: "all",
      type: "system",
      title: "🎁 A referral turned into work",
      body: `${referrerName} introduced ${lead?.title ?? "a lead"} — decide what they're owed.`,
      link: referral.referrer_client_id
        ? `/clients/${referral.referrer_client_id}`
        : "/crm",
    });
  } catch {
    // Winning the lead is what matters; the credit is bookkeeping.
  }
}
