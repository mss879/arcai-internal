import { INVOICE_COMPANY, INVOICE_SIGNOFF } from "@/lib/invoice";

/**
 * A notice is the prose sibling of an invoice: identical letterhead, contact
 * block and signed sign-off, but the middle carries a written message instead
 * of line items. The company/sign-off details are deliberately re-exported
 * from @/lib/invoice rather than copied — edit them there once and both
 * documents follow.
 */

export const NOTICE_COMPANY = INVOICE_COMPANY;
export const NOTICE_SIGNOFF = INVOICE_SIGNOFF;

/**
 * Every notice opens with this line. It's printed by the template rather than
 * stored in the body, so it can never be edited away or duplicated by the AI.
 */
export const NOTICE_GREETING = "Dear Client,";

/** Fallback subject when the user hasn't written (and AI hasn't proposed) one. */
export const NOTICE_SUBJECT_FALLBACK = "NOTICE";

/**
 * Split a stored body into printable paragraphs. Blank lines separate
 * paragraphs; single newlines inside a paragraph are folded into spaces so a
 * dictated ramble doesn't print as a ragged column.
 */
export function noticeParagraphs(body: string): string[] {
  return (body || "")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
}

/**
 * Strip a greeting the AI may have prepended despite being told not to. The
 * template always prints NOTICE_GREETING itself, so a body that starts with
 * "Dear ..." would render it twice.
 */
export function stripGreeting(body: string): string {
  return (body || "").replace(/^\s*dear\b[^\n,]*,?\s*\n*/i, "").trimStart();
}

/**
 * Drop a sign-off the AI may have appended ("Sincerely, M S Shamir"). The
 * template prints the real signed sign-off in the footer, so a written one in
 * the body is a duplicate.
 */
export function stripSignoff(body: string): string {
  return (body || "")
    .replace(
      /\n+\s*(sincerely|regards|kind regards|best regards|yours (sincerely|faithfully|truly)|thank you|thanks)\s*,?\s*(\n.*)*$/i,
      "",
    )
    .trimEnd();
}

/** Normalise an AI- or human-written body for storage and printing. */
export function cleanNoticeBody(body: string): string {
  return stripSignoff(stripGreeting(body)).trim();
}

/** Uppercase, trimmed subject line as printed on the document. */
export function displaySubject(subject: string): string {
  const s = (subject || "").trim();
  return (s || NOTICE_SUBJECT_FALLBACK).toUpperCase();
}
