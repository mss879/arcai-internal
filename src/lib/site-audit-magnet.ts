import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { analyzeSeo, extractCopyrightYear, quickSiteVerdict } from "@/lib/ai/site-audit";
import { runPageSpeed, type PageSpeedResult } from "@/lib/ai/pagespeed";
import { probeSite } from "@/lib/ai/site-probe";
import type { OnPageCheck, StrategyReadings } from "@/lib/audit-pdf";
import type { Database } from "@/lib/database.types";
import { sendAndLogEmail } from "@/lib/email-outbox";

type DB = SupabaseClient<Database>;

/**
 * The free website audit — the thing that gets a stranger to give us their
 * email (0117).
 *
 * The agency already had all of this: it audits a prospect's site during cold
 * outreach and again inside the WhatsApp showcase. What it did not have was a
 * page a stranger could arrive at from an ad or a post, ask for the audit and
 * receive it — the single cheapest way to turn traffic into a named lead.
 *
 * Deliberately queued rather than run in the request. A real audit is a
 * Lighthouse run and a homepage fetch: twenty to forty seconds on a good day,
 * which is longer than the serverless budget and far longer than anyone will
 * watch a spinner. So the form says "it's on its way", and this runs on the
 * tick — one at a time, because PageSpeed is rate-limited and metered.
 */

/** One per tick: a Lighthouse run is slow and the tick is shared. */
const MAX_AUDITS_PER_TICK = 1;

export type AuditTickResult = { audited: number; failed: number };

function readings(psi: PageSpeedResult): StrategyReadings {
  return {
    performance: psi.performance,
    seo: psi.seo,
    accessibility: psi.accessibility,
    best_practices: psi.bestPractices,
    metrics: psi.metrics,
    failed_audits: psi.failedAudits,
  };
}

/** The on-page checks, in the words a non-technical owner understands. */
function onPageChecks(html: string): OnPageCheck[] {
  const seo = analyzeSeo(html);
  const altOk = seo.imgTotal <= 3 || seo.imgWithAlt / seo.imgTotal >= 0.5;
  return [
    { label: "Page title", pass: Boolean(seo.title), note: "What Google shows as your headline in search results." },
    { label: "Meta description", pass: Boolean(seo.metaDescription), note: "The snippet under your Google result — missing = fewer clicks." },
    { label: "Main headline (H1)", pass: Boolean(seo.h1), note: "Tells visitors and Google what the page is about." },
    { label: "Mobile viewport", pass: Boolean(seo.viewport), note: "Without it the layout breaks on phones." },
    { label: "Social preview tags", pass: Boolean(seo.openGraph), note: "Shared links show an image + title instead of nothing." },
    { label: "Structured data", pass: Boolean(seo.schema), note: "Unlocks rich Google results (stars, info panels)." },
    { label: "Canonical URL", pass: Boolean(seo.canonical), note: "Stops Google splitting your ranking across duplicate URLs." },
    { label: "Favicon", pass: Boolean(seo.favicon), note: "The little logo in browser tabs and search results." },
    { label: "Image alt text", pass: altOk, note: "Helps Google read your images and screen-reader users browse." },
  ];
}

export async function processSiteAudits(db: DB): Promise<AuditTickResult> {
  const result: AuditTickResult = { audited: 0, failed: 0 };

  const { data: queued } = await db
    .from("site_audit_requests")
    .select("id, url, email, name, lead_id")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(MAX_AUDITS_PER_TICK);
  if (!queued?.length) return result;

  for (const request of queued) {
    // Claim before the work, so a tick that dies doesn't hand the same slow
    // audit to the next one forever.
    const { data: claimed } = await db
      .from("site_audit_requests")
      .update({ status: "running" })
      .eq("id", request.id)
      .eq("status", "queued")
      .select("id");
    if (!claimed?.length) continue;

    try {
      await runOne(db, request);
      result.audited += 1;
    } catch (e) {
      result.failed += 1;
      await db
        .from("site_audit_requests")
        .update({
          status: "failed",
          error: e instanceof Error ? e.message : "The audit failed.",
        })
        .eq("id", request.id);
    }
  }

  return result;
}

async function runOne(
  db: DB,
  request: { id: string; url: string; email: string; name: string | null; lead_id: string | null },
): Promise<void> {
  const probe = await probeSite(request.url);
  if (probe.verdict !== "up" || !probe.html) {
    // A site we cannot reach still deserves an answer — that IS the finding.
    await emailReport(db, request, {
      business: request.name || request.url,
      url: request.url,
      dateISO: new Date().toISOString().slice(0, 10),
      mobile: null,
      desktop: null,
      onPage: [],
      otherIssues: [
        "We couldn't load your site from our servers. That usually means it is down, blocking automated visitors, or the address has a typo — and if we can't reach it, neither can Google.",
      ],
      summary: "We couldn't reach the site to measure it.",
    });
    return;
  }

  const url = probe.finalUrl || request.url;
  // Mobile only: it is what Google ranks on, and one run rather than two
  // keeps this inside a tick.
  const psi = await runPageSpeed(url, "mobile").catch(() => null);

  const seo = analyzeSeo(probe.html);
  const verdict = quickSiteVerdict({
    seo,
    https: url.startsWith("https://"),
    copyrightYear: extractCopyrightYear(probe.html),
    contentChars: probe.html.length,
  });

  await db
    .from("site_audit_requests")
    .update({ verdict: { score: verdict.score, issues: verdict.issues } })
    .eq("id", request.id);

  await emailReport(db, request, {
    business: request.name || new URL(url).hostname,
    url,
    dateISO: new Date().toISOString().slice(0, 10),
    mobile: psi ? readings(psi) : null,
    desktop: null,
    onPage: onPageChecks(probe.html),
    otherIssues: verdict.issues,
    summary: psi
      ? undefined
      : "PageSpeed didn't answer in time, so this report covers the on-page checks only.",
  });
}

async function emailReport(
  db: DB,
  request: { id: string; email: string; name: string | null; lead_id: string | null },
  data: import("@/lib/audit-pdf").AuditReportData,
): Promise<void> {
  const { renderAuditReportPdf } = await import("@/lib/audit-pdf");
  const pdf = await renderAuditReportPdf(data);

  const passes = data.onPage.filter((c) => c.pass).length;
  const total = data.onPage.length;

  const res = await sendAndLogEmail(db, {
    to: request.email,
    kind: "compose",
    actor: "system",
    leadId: request.lead_id,
    message: {
      transport: "generic",
      subject: `Your website audit — ${data.business}`,
      body: [
        `Hi${request.name ? ` ${request.name.split(/\s+/)[0]}` : ""},`,
        `Here's the audit of ${data.url}, attached as a PDF.`,
        total
          ? `It passed ${passes} of ${total} on-page checks${data.otherIssues.length ? `, and we found ${data.otherIssues.length} other thing${data.otherIssues.length === 1 ? "" : "s"} worth fixing` : ""}.`
          : "",
        "Everything in it is measured, not guessed — the same checks Google runs.",
        "If you'd like us to walk you through it, just reply to this email.",
      ]
        .filter(Boolean)
        .join("\n"),
      attachments: [
        {
          filename: `Website-audit-${data.business.replace(/[^a-zA-Z0-9._-]/g, "-")}.pdf`,
          content: pdf,
        },
      ],
    },
  });

  await db
    .from("site_audit_requests")
    .update({
      status: res.sent ? "sent" : "failed",
      report: data as unknown as Record<string, unknown>,
      emailed_at: res.sent ? new Date().toISOString() : null,
      error: res.sent ? null : (res.error ?? "The email didn't send."),
    })
    .eq("id", request.id);

  if (res.sent && request.lead_id) {
    await db.from("lead_activities").insert({
      lead_id: request.lead_id,
      kind: "email",
      title: "Free website audit sent",
      body: `Audit of ${data.url} emailed to ${request.email}.`,
      actor_id: null,
    });
  }
}
