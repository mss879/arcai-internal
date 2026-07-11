import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Thin Meta WhatsApp Business Cloud API client.
 *
 * Reads from the environment (SERVER ONLY — none of these may ever reach
 * the browser):
 *
 *   WHATSAPP_ACCESS_TOKEN     permanent System User token with
 *                             whatsapp_business_messaging permission
 *   WHATSAPP_PHONE_NUMBER_ID  the sending number's id (NOT the number itself)
 *   WHATSAPP_VERIFY_TOKEN     any secret string; must match the value typed
 *                             into the Meta webhook config screen
 *   WHATSAPP_APP_SECRET       optional — enables X-Hub-Signature-256
 *                             verification of inbound webhooks
 *   WHATSAPP_API_VERSION      optional, default v21.0
 *   WHATSAPP_DEFAULT_COUNTRY_CODE  optional, default 94 (Sri Lanka) — used
 *                             to normalize local numbers like 0771234567
 *
 * IMPORTANT — the 24-hour window: WhatsApp only allows free-form text
 * within 24h of the customer's LAST inbound message. Outside that window
 * you must send a pre-approved template (sendWhatsAppTemplate). Automations
 * that "warm" old contacts should therefore use a template name.
 */

const GRAPH_BASE = "https://graph.facebook.com";

function apiVersion(): string {
  return process.env.WHATSAPP_API_VERSION?.trim() || "v21.0";
}

function accessToken(): string {
  return process.env.WHATSAPP_ACCESS_TOKEN?.trim() || "";
}

function phoneNumberId(): string {
  return process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() || "";
}

export function isWhatsAppConfigured(): boolean {
  return Boolean(accessToken() && phoneNumberId());
}

export function whatsAppVerifyToken(): string {
  return process.env.WHATSAPP_VERIFY_TOKEN?.trim() || "";
}

/**
 * Normalize any phone input to a digits-only international number (Meta's
 * wa_id format, no "+"), defaulting local numbers to Sri Lanka:
 *   +94 77 123 4567 → 94771234567 | 0771234567 → 94771234567
 */
export function normalizeWaPhone(
  raw: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const cc = process.env.WHATSAPP_DEFAULT_COUNTRY_CODE?.trim() || "94";
  let digits = (raw || "").replace(/[^\d]/g, "");
  if (!digits) return { ok: false, error: "Enter a phone number." };

  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = `${cc}${digits.slice(1)}`;
  else if (digits.length === 9) digits = `${cc}${digits}`;

  if (digits.length < 8 || digits.length > 15) {
    return { ok: false, error: `"${raw}" doesn't look like a valid phone number.` };
  }
  return { ok: true, value: digits };
}

/** Pretty-print a wa_id, e.g. 94771234567 → +94 77 123 4567 (SL) or +… */
export function formatWaPhone(waId: string): string {
  const m = waId.match(/^94(\d{2})(\d{3})(\d{4})$/);
  if (m) return `+94 ${m[1]} ${m[2]} ${m[3]}`;
  return `+${waId}`;
}

export type WaSendResult =
  | { ok: true; waMessageId: string | null }
  | { ok: false; error: string };

async function postMessages(payload: Record<string, unknown>): Promise<WaSendResult> {
  if (!isWhatsAppConfigured()) {
    return {
      ok: false,
      error:
        "WhatsApp isn't configured. Add WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID to .env.local.",
    };
  }
  try {
    const res = await fetch(
      `${GRAPH_BASE}/${apiVersion()}/${phoneNumberId()}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken()}`,
        },
        body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      },
    );
    const json = (await res.json().catch(() => null)) as {
      messages?: { id?: string }[];
      error?: { message?: string; error_data?: { details?: string } };
    } | null;

    if (res.ok) {
      return { ok: true, waMessageId: json?.messages?.[0]?.id ?? null };
    }
    const detail =
      json?.error?.error_data?.details ||
      json?.error?.message ||
      `WhatsApp API responded with HTTP ${res.status}.`;
    return { ok: false, error: detail };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof Error && e.name === "TimeoutError"
          ? "WhatsApp API timed out. Try again."
          : e instanceof Error
            ? e.message
            : "Could not reach the WhatsApp API.",
    };
  }
}

/**
 * Send a free-form text message. Only delivers inside the 24h customer
 * service window — outside it Meta rejects with a "re-engagement" error
 * (use sendWhatsAppTemplate instead).
 */
export async function sendWhatsAppText(opts: {
  to: string;
  body: string;
}): Promise<WaSendResult> {
  const body = opts.body.trim();
  if (!body) return { ok: false, error: "Message is empty." };
  if (body.length > 4096) {
    return { ok: false, error: `Message is too long (${body.length}/4096 characters).` };
  }
  return postMessages({
    to: opts.to,
    type: "text",
    text: { body, preview_url: true },
  });
}

/**
 * Send a pre-approved template (required outside the 24h window).
 * `bodyParams` fill the template's {{1}}, {{2}}… body placeholders.
 */
export async function sendWhatsAppTemplate(opts: {
  to: string;
  template: string;
  language?: string;
  bodyParams?: string[];
}): Promise<WaSendResult> {
  const name = opts.template.trim();
  if (!name) return { ok: false, error: "Template name is empty." };
  return postMessages({
    to: opts.to,
    type: "template",
    template: {
      name,
      language: { code: opts.language?.trim() || "en" },
      ...(opts.bodyParams?.length
        ? {
            components: [
              {
                type: "body",
                parameters: opts.bodyParams.map((text) => ({ type: "text", text })),
              },
            ],
          }
        : {}),
    },
  });
}

/** Mark an inbound message as read (blue ticks). Best-effort, never throws. */
export async function markWhatsAppRead(waMessageId: string): Promise<void> {
  if (!isWhatsAppConfigured() || !waMessageId) return;
  try {
    await fetch(`${GRAPH_BASE}/${apiVersion()}/${phoneNumberId()}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken()}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: waMessageId,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    // Read receipts are cosmetic — never let them break message handling.
  }
}

/**
 * Verify Meta's X-Hub-Signature-256 header against the raw request body.
 * Returns true when WHATSAPP_APP_SECRET is unset (verification disabled).
 */
export function verifyWaSignature(rawBody: string, header: string | null): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET?.trim();
  if (!secret) return true;
  if (!header?.startsWith("sha256=")) return false;
  try {
    const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
    const given = header.slice("sha256=".length);
    return (
      given.length === expected.length &&
      timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"))
    );
  } catch {
    return false;
  }
}
