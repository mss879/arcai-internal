import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { generatePasscode } from "@/lib/portal-access";
import { isSmsConfigured, sendSms } from "@/lib/sms";
import { countSmsSegments, normalizePhone } from "@/lib/sms-utils";

type DB = SupabaseClient<Database>;

/**
 * Client accounts (BIG-1, 0099).
 *
 * A client used to get one unguessable URL per project. Three projects meant
 * three links to keep track of, and a forwarded WhatsApp message was a
 * permanent grant to whoever received it.
 *
 * Now they sign in with their PHONE and a 6-digit SMS code, and see all of
 * their work in one place. Phone rather than email because it is the channel
 * this agency actually reaches clients on — Notify.lk is already wired, and
 * `clients.phone` is far better populated than `clients.email`.
 *
 * Three things keep a 6-digit code honest:
 *
 *   • codes are stored HASHED, so a leaked table row is not a login;
 *   • they expire in ten minutes and are consumed on first correct use;
 *   • wrong answers are counted per code, and a phone can only ask for so
 *     many codes an hour. As with the portal passcode, the counter — not the
 *     length — is the protection.
 *
 * The share token does NOT go away. It stays as the convenience it always
 * was; it is simply no longer the only way in.
 */

const COOKIE = "arc_client";
/** How long a code is good for. Long enough to find the SMS, short enough to matter. */
const CODE_TTL_MINUTES = 10;
/** Wrong guesses against one code before it is dead. */
const MAX_CODE_ATTEMPTS = 5;
/** Codes one number may request in the window below. */
const MAX_CODES_PER_WINDOW = 5;
const REQUEST_WINDOW_MINUTES = 60;
/** How long a signed-in client stays signed in. */
const SESSION_DAYS = 30;

/**
 * The signing key.
 *
 * The service-role key, exactly as portal-access.ts uses it: already
 * server-only, already required for any of this to work, and rotating it
 * should sign every client out — which is the behaviour you want from a
 * rotation anyway.
 */
function signingKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set.");
  return key;
}

function hash(value: string): string {
  return createHmac("sha256", signingKey()).update(value).digest("hex");
}

function sameValue(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** The cookie value: the client id, plus a signature over it. */
function sessionValue(clientId: string): string {
  return `${clientId}.${hash(`client-session:${clientId}`)}`;
}

// ---------------------------------------------------------------------------
// Requesting a code
// ---------------------------------------------------------------------------

export type RequestCodeResult =
  | { ok: true; sentTo: string }
  | { ok: false; error: string };

/**
 * Send a login code to a phone number.
 *
 * Deliberately does NOT reveal whether the number belongs to a client. An
 * unknown number gets the same "we've sent a code" answer and no SMS —
 * otherwise this endpoint becomes a way to enumerate the client list.
 */
export async function requestClientCode(
  supabase: DB,
  rawPhone: string,
): Promise<RequestCodeResult> {
  const phone = normalizePhone(rawPhone);
  if (!phone.ok) return { ok: false, error: "That doesn't look like a phone number." };

  // Rate limit by number, whether or not it matches a client — the limit has
  // to bite before the lookup or it protects nothing.
  const windowStart = new Date(
    Date.now() - REQUEST_WINDOW_MINUTES * 60_000,
  ).toISOString();
  const { count } = await supabase
    .from("client_login_codes")
    .select("id", { count: "exact", head: true })
    .eq("phone", phone.value)
    .gte("created_at", windowStart);
  if ((count ?? 0) >= MAX_CODES_PER_WINDOW)
    return {
      ok: false,
      error: "Too many codes requested. Try again in an hour, or message us on WhatsApp.",
    };

  const masked = maskPhone(phone.value);
  const client = await findClientByPhone(supabase, phone.value);

  // No client: same answer, no SMS, no row. Silence is the point.
  if (!client) return { ok: true, sentTo: masked };

  if (!isSmsConfigured())
    return { ok: false, error: "SMS isn't set up, so a code can't be sent right now." };

  const code = generatePasscode();
  const { error } = await supabase.from("client_login_codes").insert({
    phone: phone.value,
    code_hash: hash(`${phone.value}:${code}`),
    expires_at: new Date(Date.now() + CODE_TTL_MINUTES * 60_000).toISOString(),
  });
  if (error) return { ok: false, error: "Could not create a code. Try again." };

  const message = `${code} is your ARC AI access code. It expires in ${CODE_TTL_MINUTES} minutes. If you didn't ask for it, ignore this message.`;
  const sent = await sendSms({
    to: phone.value,
    message,
    contactName: client.name,
  });
  await supabase.from("sms_messages").insert({
    to_number: phone.value,
    // The code itself is NOT written to the message log — that log is
    // readable by the whole team, and a login code is not theirs to have.
    message: "ARC AI portal access code (redacted)",
    client_id: client.id,
    client_name: client.name,
    kind: "custom",
    status: sent.ok ? "sent" : "failed",
    error: sent.ok ? null : sent.error,
    segments: countSmsSegments(message),
    created_by: null,
  });

  if (!sent.ok) return { ok: false, error: "The code couldn't be sent. Try again." };
  return { ok: true, sentTo: masked };
}

// ---------------------------------------------------------------------------
// Verifying a code
// ---------------------------------------------------------------------------

export type VerifyCodeResult =
  | { ok: true; clientId: string; clientName: string }
  | { ok: false; error: string };

export async function verifyClientCode(
  supabase: DB,
  rawPhone: string,
  typed: string,
): Promise<VerifyCodeResult> {
  const phone = normalizePhone(rawPhone);
  if (!phone.ok) return { ok: false, error: "That doesn't look like a phone number." };

  const code = typed.replace(/\D/g, "");
  if (code.length !== 6) return { ok: false, error: "Enter the 6-digit code." };

  const { data: row } = await supabase
    .from("client_login_codes")
    .select("id, code_hash, expires_at, attempts, consumed_at")
    .eq("phone", phone.value)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!row) return { ok: false, error: "That code has expired. Ask for a new one." };
  if (new Date(row.expires_at).getTime() < Date.now())
    return { ok: false, error: "That code has expired. Ask for a new one." };
  if (row.attempts >= MAX_CODE_ATTEMPTS)
    return { ok: false, error: "Too many wrong tries. Ask for a new code." };

  if (!sameValue(row.code_hash, hash(`${phone.value}:${code}`))) {
    await supabase
      .from("client_login_codes")
      .update({ attempts: row.attempts + 1 })
      .eq("id", row.id);
    const left = MAX_CODE_ATTEMPTS - row.attempts - 1;
    return {
      ok: false,
      error:
        left > 0
          ? `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.`
          : "Too many wrong tries. Ask for a new code.",
    };
  }

  const client = await findClientByPhone(supabase, phone.value);
  if (!client) return { ok: false, error: "We couldn't find your account." };

  // Consume it: a correct code is good exactly once.
  await supabase
    .from("client_login_codes")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", row.id);

  const { data: current } = await supabase
    .from("clients")
    .select("portal_login_count")
    .eq("id", client.id)
    .maybeSingle();
  await supabase
    .from("clients")
    .update({
      portal_last_login_at: new Date().toISOString(),
      portal_login_count: (current?.portal_login_count ?? 0) + 1,
    })
    .eq("id", client.id);

  return { ok: true, clientId: client.id, clientName: client.name };
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export async function grantClientSession(clientId: string): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, sessionValue(clientId), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/portal",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function endClientSession(): Promise<void> {
  const jar = await cookies();
  jar.delete({ name: COOKIE, path: "/portal" });
}

/**
 * The signed-in client, or null.
 *
 * The cookie carries the client id AND a signature over it, so a client
 * cannot edit their own cookie into somebody else's account.
 */
export async function currentClientId(): Promise<string | null> {
  const jar = await cookies();
  const held = jar.get(COOKIE)?.value;
  if (!held) return null;

  const at = held.lastIndexOf(".");
  if (at <= 0) return null;
  const clientId = held.slice(0, at);
  const signature = held.slice(at + 1);
  if (!clientId || !signature) return null;

  try {
    if (!sameValue(signature, hash(`client-session:${clientId}`))) return null;
  } catch {
    return null;
  }
  return clientId;
}

// ---------------------------------------------------------------------------

/**
 * Match a phone number to a client.
 *
 * `clients.phone` is free text typed by people, so the stored value may be
 * "077 185 2522", "+94771852522" or "0771852522" for the same person. The
 * candidates are normalised in memory and compared — a LIKE against the raw
 * column would miss most of them.
 */
async function findClientByPhone(
  supabase: DB,
  e164: string,
): Promise<{ id: string; name: string } | null> {
  const { data } = await supabase
    .from("clients")
    .select("id, name, phone")
    .not("phone", "is", null)
    .limit(2000);

  for (const c of data ?? []) {
    const theirs = normalizePhone(c.phone ?? "");
    if (theirs.ok && theirs.value === e164) return { id: c.id, name: c.name };
  }
  return null;
}

/** "+94771852522" -> "+9477•••2522", for a "we sent it to…" line. */
function maskPhone(e164: string): string {
  if (e164.length < 8) return e164;
  return `${e164.slice(0, 5)}•••${e164.slice(-4)}`;
}
