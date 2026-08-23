"use server";

/**
 * The client portal's sign-in (BIG-1, 0099).
 *
 * Public POST endpoints, so both re-derive everything they need and neither
 * trusts a thing from the caller beyond a phone number and six digits. The
 * same rule `openPortal()` follows in the share-token portal (invariant 5).
 */

import { redirect } from "next/navigation";

import {
  endClientSession,
  grantClientSession,
  requestClientCode,
  verifyClientCode,
} from "@/lib/client-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export type CodeRequestResult =
  | { ok: true; sentTo: string }
  | { ok: false; error: string };

export async function sendLoginCode(phone: string): Promise<CodeRequestResult> {
  // Admin client on purpose: there is no signed-in user here, and the client
  // list is not readable anonymously. Nothing about the lookup is returned —
  // an unknown number gets the identical answer.
  return requestClientCode(createAdminClient(), phone);
}

export type LoginResult = { ok: true } | { ok: false; error: string };

export async function verifyLoginCode(
  phone: string,
  code: string,
): Promise<LoginResult> {
  const res = await verifyClientCode(createAdminClient(), phone, code);
  if (!res.ok) return { ok: false, error: res.error };
  await grantClientSession(res.clientId);
  return { ok: true };
}

export async function signOutClient(): Promise<void> {
  await endClientSession();
  redirect("/portal/login");
}
