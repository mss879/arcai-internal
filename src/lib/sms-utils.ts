/**
 * SMS helpers that are safe on both server and client.
 * The Notify.lk API calls themselves live in `@/lib/sms` (server-only).
 */

/** Notify.lk hard limit for a single send. */
export const SMS_MAX_LENGTH = 621;

/** Personalization tokens available in composed messages. */
export const SMS_TOKENS = [
  { token: "{{name}}", label: "Client first name" },
  { token: "{{full_name}}", label: "Client full name" },
] as const;

/**
 * Characters in the basic GSM 03.38 set. Anything outside it (Sinhala,
 * Tamil, emoji, smart quotes…) forces the message to be sent as unicode.
 */
const GSM_REGEX =
  /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑܧ¿äöñüà^{}\\[~\]|€]*$/;

export function isUnicodeMessage(message: string): boolean {
  return !GSM_REGEX.test(message);
}

/**
 * Estimate how many SMS segments a message uses (GSM: 160 single /
 * 153 concatenated; unicode: 70 single / 67 concatenated).
 */
export function countSmsSegments(message: string): number {
  if (!message) return 0;
  const unicode = isUnicodeMessage(message);
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  return message.length <= single ? 1 : Math.ceil(message.length / multi);
}

export type PhoneResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Normalize a phone number to the Notify.lk format `94XXXXXXXXX`.
 * Accepts "+94 71 234 5678", "0712345678", "712345678" or "94712345678".
 */
export function normalizePhone(raw: string): PhoneResult {
  const digits = (raw || "").replace(/[^\d]/g, "");
  if (!digits) return { ok: false, error: "Enter a phone number." };

  let normalized = digits;
  if (digits.startsWith("0094")) normalized = digits.slice(2);
  else if (digits.startsWith("94")) normalized = digits;
  else if (digits.startsWith("0")) normalized = `94${digits.slice(1)}`;
  else if (digits.length === 9) normalized = `94${digits}`;

  if (!/^94\d{9}$/.test(normalized)) {
    return {
      ok: false,
      error:
        "Use a Sri Lankan number like 0712345678 or 94712345678 (Notify.lk format).",
    };
  }
  return { ok: true, value: normalized };
}

/** Pretty-print a normalized number, e.g. 94712345678 -> +94 71 234 5678. */
export function formatPhone(value: string): string {
  const match = value.match(/^94(\d{2})(\d{3})(\d{4})$/);
  if (!match) return value;
  return `+94 ${match[1]} ${match[2]} ${match[3]}`;
}

/** Replace {{name}} / {{full_name}} tokens with the client's name. */
export function personalizeMessage(message: string, clientName: string): string {
  const fullName = (clientName || "").trim();
  const firstName = fullName.split(/\s+/)[0] || "there";
  return message
    .replaceAll("{{full_name}}", fullName || "there")
    .replaceAll("{{name}}", firstName);
}
