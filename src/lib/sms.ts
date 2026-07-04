import "server-only";

import { SMS_MAX_LENGTH, isUnicodeMessage } from "@/lib/sms-utils";

/**
 * Thin Notify.lk client (https://developer.notify.lk).
 * Reads NOTIFYLK_USER_ID / NOTIFYLK_API_KEY / NOTIFYLK_SENDER_ID from the
 * environment. SERVER ONLY — the API key must never reach the browser.
 */

const NOTIFY_BASE = "https://app.notify.lk/api/v1";

export function isSmsConfigured(): boolean {
  return Boolean(
    process.env.NOTIFYLK_USER_ID?.trim() && process.env.NOTIFYLK_API_KEY?.trim(),
  );
}

/** The approved sender id; Notify.lk's shared demo id until one is approved. */
export function smsSenderId(): string {
  return process.env.NOTIFYLK_SENDER_ID?.trim() || "NotifyDEMO";
}

export type SendSmsResult = { ok: true } | { ok: false; error: string };

/**
 * Send one SMS via Notify.lk. `to` must already be normalized to
 * 94XXXXXXXXX (use `normalizePhone` from `@/lib/sms-utils`).
 */
export async function sendSms(opts: {
  to: string;
  message: string;
  contactName?: string;
}): Promise<SendSmsResult> {
  if (!isSmsConfigured()) {
    return {
      ok: false,
      error:
        "Notify.lk isn't configured. Add NOTIFYLK_USER_ID and NOTIFYLK_API_KEY to .env.local.",
    };
  }

  const message = opts.message.trim();
  if (!message) return { ok: false, error: "Message is empty." };
  if (message.length > SMS_MAX_LENGTH) {
    return {
      ok: false,
      error: `Message is too long (${message.length}/${SMS_MAX_LENGTH} characters).`,
    };
  }

  const body = new URLSearchParams({
    user_id: process.env.NOTIFYLK_USER_ID!.trim(),
    api_key: process.env.NOTIFYLK_API_KEY!.trim(),
    sender_id: smsSenderId(),
    to: opts.to,
    message,
  });
  if (isUnicodeMessage(message)) body.set("type", "unicode");
  if (opts.contactName?.trim()) {
    const [first, ...rest] = opts.contactName.trim().split(/\s+/);
    body.set("contact_fname", first);
    if (rest.length > 0) body.set("contact_lname", rest.join(" "));
  }

  try {
    const res = await fetch(`${NOTIFY_BASE}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });

    const json = (await res.json().catch(() => null)) as {
      status?: string;
      data?: unknown;
      message?: string;
    } | null;

    if (json?.status === "success") return { ok: true };

    const detail =
      (typeof json?.data === "string" && json.data) ||
      json?.message ||
      `Notify.lk responded with HTTP ${res.status}.`;
    return { ok: false, error: detail };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof Error && e.name === "TimeoutError"
          ? "Notify.lk timed out. Try again."
          : e instanceof Error
            ? e.message
            : "Could not reach Notify.lk.",
    };
  }
}

export type SmsAccountStatus = { active: boolean; balance: number };

/** Account status + balance, or null when unconfigured/unreachable. */
export async function getSmsAccountStatus(): Promise<SmsAccountStatus | null> {
  if (!isSmsConfigured()) return null;

  const params = new URLSearchParams({
    user_id: process.env.NOTIFYLK_USER_ID!.trim(),
    api_key: process.env.NOTIFYLK_API_KEY!.trim(),
  });

  try {
    const res = await fetch(`${NOTIFY_BASE}/status?${params}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });
    const json = (await res.json().catch(() => null)) as {
      status?: string;
      data?: { active?: boolean; acc_balance?: number };
    } | null;
    if (json?.status !== "success" || !json.data) return null;
    return {
      active: Boolean(json.data.active),
      balance: Number(json.data.acc_balance ?? 0),
    };
  } catch {
    return null;
  }
}
