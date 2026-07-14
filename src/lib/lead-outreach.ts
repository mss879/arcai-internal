import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, LeadOutreachStatus } from "@/lib/database.types";
import {
  researchSiteAudit,
  isResearchConfigured,
  extractEmails,
} from "@/lib/ai/lead-research";
import { firecrawlScrape, isFirecrawlConfigured } from "@/lib/ai/firecrawl";
import { openaiChatJSON, isOpenAIConfigured } from "@/lib/ai/openai";
import { checkEmail } from "@/lib/email-check";
import { sendGenericEmail } from "@/lib/email";
import type { ResearchAudit } from "@/lib/research-report";

/** ARC AI's contact block — appended to EVERY outreach pitch (see coldFooter). */
const OUTREACH_CONTACT = {
  name: "ARC AI",
  website: "www.arcai.agency",
  websiteUrl: "https://www.arcai.agency",
  phones: [
    { label: "UK", number: "+44 7466 368427" },
    { label: "Sri Lanka", number: "+94 77 185 2522" },
  ],
  address: "91 Daisy Villa Avenue, Colombo 4, Sri Lanka",
};

type DB = SupabaseClient<Database>;
type OutreachRow = Database["public"]["Tables"]["lead_outreach"]["Row"];
type LeadRow = Database["public"]["Tables"]["leads"]["Row"];

export type OutreachTickResult = { processed: number; failed: number };

const MODEL = process.env.OPENAI_PROSPECTING_MODEL || undefined;
/** How many draft pipelines to advance per minute-tick (bounds cost + reputation). */
const MAX_PER_TICK = 3;
/** Max scraped emails to actually message per lead. */
const MAX_RECIPIENTS = 5;
/** Lease TTL — mirror research.ts; each step is internally timeout-capped well under this. */
const LOCK_TTL_MS = 45 * 1000;
/** Non-terminal states the draft pipeline can be claimed in (pending → drafting → ready). */
const CLAIMABLE: LeadOutreachStatus[] = ["pending", "drafting"];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function isEmailOutreachConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY) && isResearchConfigured();
}

/** Global outreach settings from the generic app_settings key/value store. */
export async function outreachSettings(
  supabase: DB,
): Promise<{ enabled: boolean; fromEmail: string }> {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "outreach")
    .maybeSingle();
  const v = (data?.value ?? {}) as Record<string, unknown>;
  return {
    // Auto-drafting new finds is on by default.
    enabled: v.enabled !== false,
    fromEmail:
      typeof v.from_email === "string" && v.from_email.trim()
        ? v.from_email.trim()
        : "support@arcai.agency",
  };
}

// ---------------------------------------------------------------------------
// Enqueue + recipients
// ---------------------------------------------------------------------------

/**
 * Queue an outreach draft for a lead. Insert-only with `on conflict (lead_id)
 * do nothing` — the unique constraint guarantees a lead is never queued (or
 * emailed) twice, so a re-import or an overlapping tick is a harmless no-op.
 * Never throws (fire-and-forget from the import path).
 */
export async function enqueueLeadOutreach(
  supabase: DB,
  opts: {
    leadId: string;
    recipients?: string[];
    source?: "prospecting" | "manual";
    requestedBy?: string | null;
  },
): Promise<{ ok: boolean; id?: string }> {
  try {
    const { data, error } = await supabase
      .from("lead_outreach")
      .upsert(
        {
          lead_id: opts.leadId,
          recipients: cleanEmails(opts.recipients ?? [], ""),
          source: opts.source ?? "prospecting",
          ...(opts.requestedBy ? { requested_by: opts.requestedBy } : {}),
        },
        { onConflict: "lead_id", ignoreDuplicates: true },
      )
      .select("id")
      .maybeSingle();
    if (error) {
      console.error("[outreach] enqueue failed:", error.message);
      return { ok: false };
    }
    return { ok: true, id: data?.id };
  } catch (e) {
    console.error("[outreach] enqueue threw:", e);
    return { ok: false };
  }
}

/**
 * Resolve the full send list for a lead, best source first:
 *   1. the outreach row's stored recipients,
 *   2. `leads.custom.prospect_emails` (the array Find Leads scraped),
 *   3. `leads.contact_email` (manually-added leads),
 *   4. last resort — re-scrape the homepage.
 * Deduped, junk-stripped, capped.
 */
export async function buildRecipients(
  supabase: DB,
  leadId: string,
): Promise<string[]> {
  const { data: lead } = await supabase
    .from("leads")
    .select("contact_email, company_website, custom")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return [];

  const custom = (lead.custom ?? {}) as Record<string, unknown>;
  const stored = Array.isArray(custom.prospect_emails)
    ? (custom.prospect_emails as unknown[]).map((e) => String(e))
    : [];
  const domain = domainOf(lead.company_website);

  let emails = cleanEmails(
    [...stored, ...(lead.contact_email ? [lead.contact_email] : [])],
    domain,
  );
  if (emails.length) return emails;

  // Nothing stored — try one homepage scrape before giving up.
  if (lead.company_website && isFirecrawlConfigured()) {
    try {
      const page = await firecrawlScrape(lead.company_website, { html: true });
      if (page) {
        emails = cleanEmails(
          extractEmails(page.html || page.markdown),
          domain,
        );
      }
    } catch (e) {
      console.error("[outreach] recipient re-scrape failed:", e);
    }
  }
  return emails;
}

// ---------------------------------------------------------------------------
// Draft pipeline (pending → drafting → ready). NEVER sends.
// ---------------------------------------------------------------------------

export type StepOutcome = "advanced" | "done" | "error" | "skipped";

/** Run a row through the draft pipeline in one pass (manual/inline path). */
export async function drainOutreachRow(
  supabase: DB,
  rowId: string,
  maxSteps = 4,
): Promise<StepOutcome> {
  let outcome: StepOutcome = "skipped";
  for (let i = 0; i < maxSteps; i++) {
    outcome = await advanceOutreachRow(supabase, rowId);
    if (outcome !== "advanced") break;
  }
  return outcome;
}

/**
 * Advance ONE step of a draft pipeline, lease-fenced exactly like
 * advanceResearchRow: CAS-claim the row, run one step, release the lease.
 * Stops (returns "done") once the draft is `ready` — it never sends.
 */
export async function advanceOutreachRow(
  supabase: DB,
  rowId: string,
): Promise<StepOutcome> {
  const lockCutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
  const { data: claimed } = await supabase
    .from("lead_outreach")
    .update({ locked_at: new Date().toISOString() })
    .eq("id", rowId)
    .in("status", CLAIMABLE)
    .or(`locked_at.is.null,locked_at.lt.${lockCutoff}`)
    .select("*");
  if (!claimed?.length) return "skipped";
  const row = claimed[0] as OutreachRow;
  const token = row.locked_at;
  if (!token) return "skipped";

  const commit = async (patch: Record<string, unknown>) => {
    const { error } = await supabase
      .from("lead_outreach")
      .update({ ...patch, locked_at: null })
      .eq("id", rowId)
      .eq("locked_at", token);
    if (error) throw new Error(error.message);
  };

  try {
    const { data: lead } = await supabase
      .from("leads")
      .select("*")
      .eq("id", row.lead_id)
      .maybeSingle();
    if (!lead) {
      await commit({ status: "failed", error: "Lead no longer exists." });
      return "error";
    }

    // pending → research + audit
    if (row.status === "pending") {
      const { audit, facts } = await gatherContext(supabase, lead as LeadRow);
      await commit({
        status: "drafting",
        audit: (audit ?? null) as unknown as Record<string, unknown> | null,
        audit_score: audit?.overall ?? null,
        company_facts: facts as unknown as Record<string, unknown>,
        error: null,
      });
      return "advanced";
    }

    // drafting → compose the email (never throws — template fallback)
    if (row.status === "drafting") {
      const audit = (row.audit ?? null) as ResearchAudit | null;
      const facts = (row.company_facts ?? {}) as Record<string, unknown>;
      const { subject, body } = await composeOutreachEmail(
        lead as LeadRow,
        audit,
        facts,
      );
      await commit({ status: "ready", subject, body, error: null });
      await setLeadTags(supabase, row.lead_id, ["Draft Ready"]);
      return "done";
    }

    // Unknown/terminal — release the lease (fenced).
    await supabase
      .from("lead_outreach")
      .update({ locked_at: null })
      .eq("id", rowId)
      .eq("locked_at", token);
    return "skipped";
  } catch (e) {
    console.error("[outreach] draft step failed:", e);
    await supabase
      .from("lead_outreach")
      .update({
        status: "failed",
        error: e instanceof Error ? e.message : "Draft failed.",
        attempts: row.attempts + 1,
        locked_at: null,
      })
      .eq("id", rowId)
      .eq("locked_at", token);
    return "error";
  }
}

/** Advance queued outreach drafts from the automation tick (one step each). */
export async function processDueOutreach(
  supabase: DB,
): Promise<OutreachTickResult> {
  const result: OutreachTickResult = { processed: 0, failed: 0 };
  if (!isResearchConfigured()) return result;

  const lockCutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
  const { data: rows } = await supabase
    .from("lead_outreach")
    .select("id")
    .in("status", CLAIMABLE)
    .or(`locked_at.is.null,locked_at.lt.${lockCutoff}`)
    .order("updated_at", { ascending: true })
    .limit(MAX_PER_TICK);
  if (!rows?.length) return result;

  for (const row of rows) {
    const outcome = await advanceOutreachRow(supabase, row.id);
    if (outcome === "done" || outcome === "advanced") result.processed += 1;
    else if (outcome === "error") result.failed += 1;
  }
  return result;
}

/**
 * Gather the personalization context: reuse a completed research dossier's
 * audit when one exists (zero extra spend), else run the standalone site
 * audit. A lead with no website skips the audit entirely.
 */
async function gatherContext(
  supabase: DB,
  lead: LeadRow,
): Promise<{ audit: ResearchAudit | null; facts: Record<string, unknown> }> {
  const website = lead.company_website?.trim() || "";

  // Reuse an existing finished research report's audit if we have one.
  const { data: research } = await supabase
    .from("lead_research")
    .select("report, status")
    .eq("lead_id", lead.id)
    .maybeSingle();
  if (research?.status === "done") {
    const report = (research.report ?? {}) as Record<string, unknown>;
    const audit = (report.audit ?? null) as ResearchAudit | null;
    const overview =
      typeof report.overview === "string" ? report.overview : "";
    if (audit) return { audit, facts: { overview, source: "research" } };
    if (overview) return { audit: null, facts: { overview, source: "research" } };
  }

  if (!website) {
    return { audit: null, facts: { no_website: true } };
  }

  const result = await researchSiteAudit(website);
  return {
    audit: result?.audit ?? null,
    facts: {
      measured_url: result?.audit?.measured_url ?? website,
      source: "audit",
    },
  };
}

/**
 * Write the customized cold email from real audit issues. Uses openaiChatJSON
 * (same model/shape as the prospecting drafter); a deterministic template is
 * the fallback so a row is NEVER left draftless.
 */
async function composeOutreachEmail(
  lead: LeadRow,
  audit: ResearchAudit | null,
  facts: Record<string, unknown>,
): Promise<{ subject: string; body: string }> {
  const business = lead.company?.trim() || lead.title?.trim() || "your business";
  const noWebsite = facts.no_website === true || !lead.company_website?.trim();

  if (isOpenAIConfigured()) {
    try {
      const context = [
        `business: ${business}`,
        lead.contact_name ? `owner/contact: ${lead.contact_name}` : "",
        lead.company_website ? `website: ${lead.company_website}` : "situation: has NO website",
        typeof facts.overview === "string" && facts.overview
          ? `about: ${String(facts.overview).slice(0, 600)}`
          : "",
        audit ? `website score: ${audit.overall}/100 (${audit.measured})` : "",
        audit?.issues?.length
          ? `concrete website issues:\n${audit.issues.slice(0, 6).map((i) => `- ${i}`).join("\n")}`
          : "",
        lead.notes ? `notes: ${lead.notes.slice(0, 400)}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const raw = await openaiChatJSON(
        [
          {
            role: "system",
            content: `You write ONE cold outreach email for ARC AI, a web design & digital agency in Sri Lanka. Return JSON only: {"subject": "...", "body": "..."}.
- "subject": under 60 chars, specific to THIS business, no clickbait, no emoji.
- "body": plain text, 90-140 words. Open with something SPECIFIC and true about them (a real website issue from the list, or — if they have NO website — what they're missing locally). Plainly state what it's costing them. Offer a free, no-obligation breakdown of exactly what you'd improve. Soft CTA (a quick reply or call). Greet the owner by name when given, else "Hi ${business} team". Sign off "Best regards,\\nThe ARC AI Team". NEVER invent facts, prices, or results. Do NOT write any website, phone number, address, or contact block — ARC AI's full signature (website, phone numbers, office address) and an unsubscribe link are appended automatically.`,
          },
          { role: "user", content: context },
        ],
        { model: MODEL, reasoningEffort: "low", timeoutMs: 90_000 },
      );
      const parsed = JSON.parse(raw) as { subject?: string; body?: string };
      const subject = String(parsed.subject ?? "").trim().slice(0, 120);
      const body = String(parsed.body ?? "").trim().slice(0, 2000);
      if (body) {
        return {
          subject: subject || templateOutreach(business, audit, noWebsite).subject,
          body,
        };
      }
    } catch (e) {
      console.error("[outreach] compose failed, using template:", e);
    }
  }
  return templateOutreach(business, audit, noWebsite);
}

/** Deterministic fallback so a draft is never empty. */
function templateOutreach(
  business: string,
  audit: ResearchAudit | null,
  noWebsite: boolean,
): { subject: string; body: string } {
  const topIssue = audit?.issues?.[0];
  if (noWebsite) {
    return {
      subject: `A website for ${business}?`,
      body: `Hi ${business} team,\n\nI came across ${business} online and noticed you don't have a website yet — which means customers searching for you locally are landing on competitors instead.\n\nWe're ARC AI, a web & digital agency. We'd be happy to put together a free, no-obligation breakdown of a simple site that would bring those searches back to you.\n\nWorth a quick chat? Just reply here and I'll send over some ideas.\n\nBest regards,\nThe ARC AI Team`,
    };
  }
  return {
    subject: `A few quick wins for ${business}`,
    body: `Hi ${business} team,\n\nI took a look at your website${topIssue ? ` and noticed ${lowerFirst(topIssue)}` : ""}. Small things like that quietly cost you enquiries every week.\n\nWe're ARC AI, a web & digital agency. I'd be glad to send a free, no-obligation breakdown of exactly what we'd improve — no pressure either way.\n\nWould that be useful? Just reply and I'll put it together.\n\nBest regards,\nThe ARC AI Team`,
  };
}

// ---------------------------------------------------------------------------
// Send (the Approve action's core) — validate → send → tag → log
// ---------------------------------------------------------------------------

/**
 * Approve + send a ready draft. Claims the row (ready|failed → sending) so a
 * double-click or overlapping call can't double-send, validates every recipient
 * against the suppression list + MX/junk, sends each individually (own
 * unsubscribe token), tags the lead "Email Sent" and stores the exact copy.
 */
export async function sendLeadOutreach(
  supabase: DB,
  leadId: string,
  opts?: { actorId?: string | null },
): Promise<{ ok: boolean; sent?: number; skipped?: boolean; error?: string }> {
  const { data: claimed } = await supabase
    .from("lead_outreach")
    .update({ status: "sending", error: null })
    .eq("lead_id", leadId)
    .in("status", ["ready", "failed"])
    .select("*");
  if (!claimed?.length)
    return { ok: false, error: "This draft isn't ready to send yet." };
  const row = claimed[0] as OutreachRow;

  try {
    const { fromEmail } = await outreachSettings(supabase);
    const { data: lead } = await supabase
      .from("leads")
      .select("company, title")
      .eq("id", leadId)
      .maybeSingle();
    const business = lead?.company?.trim() || lead?.title?.trim() || "your business";

    let recipients = row.recipients?.length
      ? row.recipients
      : await buildRecipients(supabase, leadId);
    recipients = await dropSuppressed(supabase, recipients);
    const checks = await Promise.all(
      recipients.map(async (e) => ({ e, ok: (await checkEmail(e)).ok })),
    );
    const valid = checks.filter((c) => c.ok).map((c) => c.e);

    if (!valid.length) {
      await supabase
        .from("lead_outreach")
        .update({ status: "skipped", sent_to: [], error: "No deliverable email address." })
        .eq("id", row.id);
      await setLeadTags(supabase, leadId, ["No Email"], ["Draft Ready"]);
      await supabase.from("crm_tasks").insert({
        lead_id: leadId,
        title: `Find an email for ${business}`,
        notes: `Outreach is drafted but no deliverable email was found for this lead. Find a contact address, add it, then re-run outreach.`,
        created_by: opts?.actorId ?? null,
      });
      return { ok: false, skipped: true, error: "No deliverable email found." };
    }

    const subject = row.subject || `A quick idea for ${business}`;
    const sent: string[] = [];
    const messageIds: string[] = [];
    let firstError = "";
    for (const email of valid) {
      const res = await sendGenericEmail({
        to: email,
        subject,
        body: row.body,
        from: fromEmail,
        replyTo: fromEmail,
        footer: coldFooter(email),
      });
      if (res.sent) {
        sent.push(email);
        if (res.id) messageIds.push(res.id);
      } else if (!firstError) {
        firstError = res.error ?? "send failed";
      }
    }

    if (!sent.length) {
      await supabase
        .from("lead_outreach")
        .update({
          status: "failed",
          error: firstError || "Every send failed.",
          attempts: row.attempts + 1,
        })
        .eq("id", row.id);
      return { ok: false, error: firstError || "Every send failed." };
    }

    const now = new Date().toISOString();
    await setLeadTags(supabase, leadId, ["Email Sent"], ["Draft Ready", "No Email"]);
    await supabase.from("lead_activities").insert({
      lead_id: leadId,
      kind: "email",
      title: `AI outreach sent: ${subject}`,
      body: row.body,
      meta: {
        recipients: sent,
        from: fromEmail,
        subject,
        message_ids: messageIds,
        audit_score: row.audit_score,
        source: row.source,
        sent_at: now,
      },
      actor_id: opts?.actorId ?? null,
    });
    await supabase
      .from("lead_outreach")
      .update({
        status: "sent",
        sent_to: sent,
        message_ids: messageIds,
        sent_at: now,
        error: null,
      })
      .eq("id", row.id);

    return { ok: true, sent: sent.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Send failed.";
    await supabase
      .from("lead_outreach")
      .update({ status: "failed", error: msg, attempts: row.attempts + 1 })
      .eq("id", row.id);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Suppression (opt-outs + bounces)
// ---------------------------------------------------------------------------

export async function suppressEmail(
  supabase: DB,
  email: string,
  reason: "unsubscribe" | "bounce" | "complaint" | "manual",
  leadId?: string | null,
): Promise<void> {
  const e = email.trim().toLowerCase();
  if (!e) return;
  await supabase
    .from("outreach_suppressions")
    .upsert({ email: e, reason, lead_id: leadId ?? null }, { onConflict: "email" });
}

async function dropSuppressed(supabase: DB, emails: string[]): Promise<string[]> {
  if (!emails.length) return emails;
  const lowered = emails.map((e) => e.trim().toLowerCase());
  const { data } = await supabase
    .from("outreach_suppressions")
    .select("email")
    .in("email", lowered);
  const blocked = new Set((data ?? []).map((r) => r.email));
  return emails.filter((e) => !blocked.has(e.trim().toLowerCase()));
}

// ---------------------------------------------------------------------------
// Unsubscribe token (HMAC) + footer
// ---------------------------------------------------------------------------

function unsubSecret(): string {
  return (
    process.env.OUTREACH_UNSUBSCRIBE_SECRET ||
    process.env.SMS_CRON_SECRET ||
    process.env.RESEND_API_KEY ||
    "arc-outreach"
  );
}

export function signUnsubscribe(email: string): string {
  return createHmac("sha256", unsubSecret())
    .update(email.trim().toLowerCase())
    .digest("hex");
}

export function verifyUnsubscribe(email: string, token: string): boolean {
  try {
    const expected = signUnsubscribe(email);
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function unsubscribeUrl(email: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || "https://arcai.online").replace(/\/$/, "");
  return `${base}/api/outreach/unsubscribe?e=${encodeURIComponent(
    email,
  )}&t=${signUnsubscribe(email)}`;
}

/**
 * The signature + CAN-SPAM footer appended to EVERY outreach pitch: ARC AI's
 * website, both phone numbers and the office address (sender identity /
 * physical address), plus the one-click unsubscribe link.
 */
function coldFooter(email: string): string {
  const phones = OUTREACH_CONTACT.phones
    .map((p) => `${p.label}: <a href="tel:${p.number.replace(/\s+/g, "")}" style="color:#475569;text-decoration:none;">${p.number}</a>`)
    .join(" &nbsp;·&nbsp; ");
  return `<div style="margin-top:28px;padding-top:16px;border-top:1px solid #eef0f6;color:#475569;font-size:13px;line-height:1.7;">
    <div style="font-weight:700;color:#0f172a;">${OUTREACH_CONTACT.name}</div>
    <div><a href="${OUTREACH_CONTACT.websiteUrl}" style="color:#f97316;text-decoration:none;">${OUTREACH_CONTACT.website}</a></div>
    <div>${phones}</div>
    <div>${OUTREACH_CONTACT.address}</div>
    <div style="margin-top:12px;color:#94a3b8;font-size:12px;line-height:1.6;">
      You're receiving this because we came across your business online.
      <a href="${unsubscribeUrl(email)}" style="color:#94a3b8;text-decoration:underline;">Unsubscribe</a> to never hear from us again.
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Add/remove tags on a lead (Set-merge, idempotent). */
async function setLeadTags(
  supabase: DB,
  leadId: string,
  add: string[] = [],
  remove: string[] = [],
): Promise<void> {
  const { data: lead } = await supabase
    .from("leads")
    .select("tags")
    .eq("id", leadId)
    .maybeSingle();
  const tags = new Set(lead?.tags ?? []);
  add.forEach((t) => tags.add(t));
  remove.forEach((t) => tags.delete(t));
  await supabase.from("leads").update({ tags: Array.from(tags) }).eq("id", leadId);
}

const JUNK_EMAIL_RE =
  /(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|abuse@|example\.|yourdomain|yoursite|sentry|wixpress|cloudflare|godaddy|privacyprotect|whoisguard|domainsbyproxy|\.png$|\.jpe?g$|\.webp$|\.gif$|\.svg$)/i;

/** Clean + rank scraped emails (own domain first), deduped, capped. */
function cleanEmails(emails: string[], ownDomain: string): string[] {
  const seen = new Set<string>();
  const cleaned = emails
    .map((e) => e.trim())
    .filter((e) => {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return false;
      if (JUNK_EMAIL_RE.test(e)) return false;
      const key = e.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const rank = (e: string): number => {
    const dom = e.split("@")[1]?.toLowerCase() ?? "";
    const own = ownDomain && (dom === ownDomain || dom.endsWith(`.${ownDomain}`));
    const generic = /^(info|hello|contact|sales|admin|office|mail|inquir|enquir)/i.test(e);
    return (own ? 0 : 2) + (generic ? 0 : 1);
  };
  return cleaned.sort((a, b) => rank(a) - rank(b)).slice(0, MAX_RECIPIENTS);
}

function domainOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}
