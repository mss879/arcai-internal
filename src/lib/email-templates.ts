import { fillTokens } from "@/lib/automation-core";

/**
 * Saved email templates, and the `{{tokens}}` they can carry.
 *
 * Deliberately client-safe and pure: the compose box previews the rendered
 * subject and body as you type, and the server renders the same way at send
 * time. Two renderers would drift, and the one that drifted would be the one
 * the client actually received.
 *
 * The token syntax is the automation engine's — `fillTokens` in
 * automation-core.ts is shared — so a phrase learned in one place works in the
 * other.
 */

export type EmailTemplateValues = Record<string, string | null | undefined>;

export type RenderedEmail = { subject: string; body: string };

/** The tokens the compose box offers, in the order it lists them. */
export const EMAIL_TOKENS: { key: string; label: string }[] = [
  { key: "name", label: "First name" },
  { key: "full_name", label: "Full name" },
  { key: "company", label: "Company" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "project", label: "Project" },
  { key: "invoice_number", label: "Invoice number" },
  { key: "quote_number", label: "Quote number" },
  { key: "amount", label: "Amount" },
  { key: "link", label: "Link" },
  { key: "sender", label: "Your name" },
];

/**
 * Fill a template's subject and body.
 *
 * A token with no value is blanked rather than left showing as `{{name}}` —
 * unlike the automation engine's mid-chain render, this is the last pass
 * before a person reads it, and a customer seeing raw braces is worse than a
 * gap. Every known token is therefore passed explicitly, defaulting to "".
 */
export function renderEmailTemplate(
  template: { subject: string; body: string },
  values: EmailTemplateValues,
): RenderedEmail {
  const complete: EmailTemplateValues = {};
  for (const { key } of EMAIL_TOKENS) complete[key] = values[key] ?? "";
  // Anything the caller passes beyond the known list still works.
  for (const [key, value] of Object.entries(values)) complete[key] = value ?? "";

  return {
    subject: fillTokens(template.subject, complete).trim(),
    body: fillTokens(template.body, complete),
  };
}

/** The first word of a name, for `{{name}}`. Blank stays blank. */
export function firstNameOf(full: string | null | undefined): string {
  return (full ?? "").trim().split(/\s+/)[0] ?? "";
}

/**
 * Which tokens a template actually uses. The compose box shows these as chips
 * so it is obvious what a saved template will pull in before you send it.
 */
export function tokensUsed(template: { subject: string; body: string }): string[] {
  const found = new Set<string>();
  for (const match of `${template.subject}\n${template.body}`.matchAll(
    /\{\{\s*([a-z0-9_]+)\s*\}\}/gi,
  )) {
    found.add(match[1].toLowerCase());
  }
  return [...found];
}
