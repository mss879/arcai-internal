import "server-only";

import { promises as dns } from "node:dns";

/**
 * Practical, free email deliverability check — no paid API.
 *
 *   format  -> a syntactically valid address
 *   junk    -> an obvious placeholder / disposable / fake (test@test.com, …)
 *   no-mx   -> the domain has no MX records, so it can't receive mail
 *
 * It confirms the DOMAIN can receive mail; it cannot confirm the exact mailbox
 * exists (that needs SMTP `RCPT` verification, which is unreliable and blocked
 * on serverless — outbound port 25). Real bounces are caught separately by the
 * Resend bounce webhook. Never throws.
 */

export type EmailCheckReason = "format" | "junk" | "no-mx";
export type EmailCheck = { ok: boolean; reason?: EmailCheckReason };

const FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Whole local-part is an obvious placeholder (optionally trailing digits):
// test@…, asdf@…, dummy123@…  — anchored so real names like "testa@" pass.
const PLACEHOLDER_LOCAL_RE =
  /^(test|tests|testing|asdf+|qwerty|fake|dummy|sample|placeholder|noemail|nomail|donotreply|do-not-reply|no-reply|noreply|xxx+|aaa+|abcabc)\d*$/i;

// Domains nobody has a real inbox on: placeholders + common disposable hosts.
const PLACEHOLDER_DOMAIN_RE =
  /@(test|example|fake|dummy|nomail|noemail|sample|placeholder|asdf|xyz|mailinator|guerrillamail|10minutemail|tempmail|trashmail|yopmail|sharklasers|getnada|maildrop)\.[a-z]{2,}$/i;

// Leftover scraped junk (defensive — a customer rarely types these).
const JUNK_EMAIL_RE =
  /(noreply|no-reply|donotreply|mailer-daemon|postmaster|abuse@|example\.|yourdomain|yoursite|\.png$|\.jpe?g$|\.webp$|\.gif$|\.svg$)/i;

/** MX lookup with a hard timeout so a slow/dead resolver can't stall the reply. */
async function hasMx(domain: string): Promise<boolean> {
  try {
    const records = await Promise.race([
      dns.resolveMx(domain),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("dns timeout")), 3000),
      ),
    ]);
    return Array.isArray(records) && records.length > 0;
  } catch {
    // ENOTFOUND / ENODATA / timeout — can't confirm the domain receives mail.
    return false;
  }
}

export async function checkEmail(email: string): Promise<EmailCheck> {
  const e = email.trim().toLowerCase();
  if (!FORMAT_RE.test(e)) return { ok: false, reason: "format" };

  const [local, domain] = e.split("@");
  if (!local || !domain) return { ok: false, reason: "format" };

  if (
    JUNK_EMAIL_RE.test(e) ||
    PLACEHOLDER_LOCAL_RE.test(local) ||
    PLACEHOLDER_DOMAIN_RE.test(e)
  ) {
    return { ok: false, reason: "junk" };
  }

  if (!(await hasMx(domain))) return { ok: false, reason: "no-mx" };
  return { ok: true };
}
