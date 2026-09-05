"use server";

import { headers } from "next/headers";

import { createInboundLead } from "@/lib/lead-intake";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ActionResult } from "@/lib/types";

/**
 * Ask for the free audit (0117). Public and unauthenticated.
 *
 * The audit itself is NOT run here. A real one is a Lighthouse run plus a
 * homepage fetch — twenty to forty seconds on a good day, longer than the
 * serverless budget and far longer than anyone will watch a spinner. So this
 * records the request, creates the lead, and says honestly that the report is
 * on its way; src/lib/site-audit-magnet.ts does the work on the tick.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Accept "acme.lk" as readily as "https://acme.lk/". */
function normaliseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function requestAudit(input: {
  url: string;
  email: string;
  name?: string;
  phone?: string;
  /** Campaign parameters from the page they landed on. */
  utm?: Record<string, string>;
  referrer?: string;
  landingUrl?: string;
  ref?: string;
}): Promise<ActionResult> {
  const supabase = createAdminClient();
  const ip = clientIp(await headers());

  // Three a day per address is generous for a real person and useless as a
  // way to make us run Lighthouse for free.
  const limit = await enforceRateLimit(supabase, `audit:${ip}`, {
    limit: 3,
    windowSec: 3600,
  });
  if (!limit.ok) {
    return {
      ok: false,
      error: "That's a few in a row — try again in an hour.",
    };
  }

  const url = normaliseUrl(input.url);
  if (!url) return { ok: false, error: "That doesn't look like a website address." };

  const email = input.email.trim();
  if (!EMAIL_RE.test(email)) {
    return { ok: false, error: "We need a real email address to send the report to." };
  }

  const name = input.name?.trim() || null;

  // The lead is the point of the magnet, and it goes through the one intake
  // path — so a visitor who already enquired doesn't become a second lead.
  const lead = await createInboundLead(supabase, {
    name,
    email,
    phone: input.phone,
    message: `Asked for a free website audit of ${url}.`,
    service: "Website audit",
    source: "audit_magnet",
    companyWebsite: url,
    tags: ["audit"],
    utm: input.utm,
    referrer: input.referrer,
    landingUrl: input.landingUrl,
    referralCode: input.ref,
  });

  const { error } = await supabase.from("site_audit_requests").insert({
    url,
    email,
    name,
    phone: input.phone?.trim() || null,
    lead_id: lead.ok ? lead.lead.id : null,
    ip,
  });
  if (error) return { ok: false, error: "Couldn't queue the audit. Try again?" };

  return { ok: true };
}
