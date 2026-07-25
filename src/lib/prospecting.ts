import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  Database,
  ProspectVerdict,
} from "@/lib/database.types";
import {
  firecrawlScrape,
  firecrawlSearch,
  isFirecrawlConfigured,
} from "@/lib/ai/firecrawl";
import {
  isPlacesConfigured,
  placesSearchAll,
  type PlaceBusiness,
} from "@/lib/ai/places";
import {
  analyzeSeo,
  extractCopyrightYear,
  extractStructuredFacts,
  quickSiteVerdict,
} from "@/lib/ai/site-audit";
import {
  brandNameFromDomain,
  cleanCompanyTitle,
  extractEmails,
  isJunkCompetitorDomain,
  sameCompany,
} from "@/lib/ai/lead-research";
import { isOpenAIConfigured, openaiChatJSON } from "@/lib/ai/openai";
import { probeSite } from "@/lib/ai/site-probe";
import { fireAutomationTrigger } from "@/lib/automation";
import { topLeadPosition } from "@/lib/crm";
import { enqueueLeadOutreach, outreachSettings } from "@/lib/lead-outreach";

type DB = SupabaseClient<Database>;
type ScanRow = Database["public"]["Tables"]["prospect_scans"]["Row"];
type CandidateRow = Database["public"]["Tables"]["prospect_candidates"]["Row"];
type LeadRow = Database["public"]["Tables"]["leads"]["Row"];

/**
 * "Find Leads" — the area-based prospecting agent.
 *
 * A scan walks `pending → searching → qualifying → drafting → importing → done`,
 * advanced one lease-fenced step at a time (the exact `research.ts` pattern) by
 * the automation tick, an inline drain after launch, and the page-open driver.
 *
 *   searching  : Google Places enumerates real businesses in the chosen area
 *                (with authoritative website presence); dedupes against every
 *                business seen before AND against the existing CRM.
 *   qualifying : batches of candidates get a website verdict — no website /
 *                social-page-only / broken / bad (quickSiteVerdict score below
 *                the scan threshold, with pitch-ready issues) are QUALIFIED;
 *                good websites are skipped with the score as the reason. A
 *                claimed "no website" is verified with a web search first so
 *                the team never emails someone who actually has a site.
 *   drafting   : one batched AI relevance pass (kills chains/institutions the
 *                deny-list missed), then personalised cold email + SMS drafts.
 *   importing  : qualified candidates become CRM leads tagged with the city,
 *                issues in the notes, the drafts logged on the lead.
 *
 * Every external call degrades gracefully; a scan is never lost mid-way.
 */

const LOCK_TTL_MS = 45 * 1000;
/** Sites scraped + verdicted per advance (fits the ~26s serverless budget). */
const QUALIFY_BATCH = 4;
/** Cold-outreach drafts per OpenAI call. */
const DRAFT_BATCH = 6;

const MODEL = process.env.OPENAI_PROSPECTING_MODEL || "gpt-5.4-mini";

/** Places `types` that are never web-design prospects. */
const DENY_TYPES = new Set([
  "government_office",
  "local_government_office",
  "city_hall",
  "courthouse",
  "embassy",
  "police",
  "fire_station",
  "post_office",
  "bank",
  "atm",
  "hospital",
  "public_bathroom",
  "school",
  "primary_school",
  "secondary_school",
  "university",
  "library",
  "place_of_worship",
  "church",
  "mosque",
  "hindu_temple",
  "synagogue",
  "cemetery",
  "park",
  "transit_station",
  "bus_station",
  "train_station",
  "subway_station",
  "airport",
]);

/** A "website" that is really just a social/profile page — a great pitch. */
const SOCIAL_ONLY_RE =
  /(facebook\.com|instagram\.com|wa\.me|api\.whatsapp\.com|linktr\.ee|tiktok\.com|business\.site|g\.page)/i;

/** ISO country codes for Firecrawl geo-bias in the no-Places fallback. */
const COUNTRY_CODES: Record<string, string> = {
  "sri lanka": "lk",
  australia: "au",
  "united kingdom": "gb",
  uk: "gb",
  "new zealand": "nz",
  india: "in",
  singapore: "sg",
  "united arab emirates": "ae",
  "united states": "us",
  usa: "us",
  canada: "ca",
};

function countryCode(country: string): string {
  return COUNTRY_CODES[country.trim().toLowerCase()] ?? "";
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function isProspectingConfigured(): boolean {
  // Firecrawl is the minimum (qualification scrapes). Places unlocks the
  // full "no website" discovery — surfaced separately in the UI.
  return isFirecrawlConfigured() || isPlacesConfigured();
}

export type ProspectTickResult = { processed: number; failed: number };

/** Non-terminal states the pipeline can be claimed in. */
const CLAIMABLE = [
  "pending",
  "searching",
  "qualifying",
  "drafting",
  "importing",
] as const;

export type ProspectStepOutcome = "advanced" | "done" | "error" | "skipped";

/**
 * Run a scan through the whole pipeline in one background pass; each step is
 * committed and lease-fenced independently, so a killed serverless run simply
 * resumes on the next tick. A 40-business scan is ~15 qualifying advances plus
 * a handful of drafting ones — cap generously.
 */
export async function drainProspectScan(
  supabase: DB,
  scanId: string,
  maxSteps = 40,
): Promise<ProspectStepOutcome> {
  let outcome: ProspectStepOutcome = "skipped";
  for (let i = 0; i < maxSteps; i++) {
    outcome = await advanceProspectScan(supabase, scanId);
    if (outcome !== "advanced") break;
  }
  return outcome;
}

/** Advance queued scans from the automation tick (one step per tick). */
export async function processPendingProspectScans(
  supabase: DB,
  limit = 1,
): Promise<ProspectTickResult> {
  const result: ProspectTickResult = { processed: 0, failed: 0 };
  if (!isProspectingConfigured()) return result;

  const lockCutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
  const { data: rows } = await supabase
    .from("prospect_scans")
    .select("id")
    .in("status", [...CLAIMABLE])
    .or(`locked_at.is.null,locked_at.lt.${lockCutoff}`)
    .order("updated_at", { ascending: true })
    .limit(Math.max(1, limit));
  if (!rows?.length) return result;

  for (const row of rows) {
    const outcome = await advanceProspectScan(supabase, row.id);
    if (outcome === "done" || outcome === "advanced") result.processed += 1;
    else if (outcome === "error") result.failed += 1;
  }
  return result;
}

/**
 * Advance ONE step. Atomically claims the scan with a short lease and fences
 * every commit on the exact lease token (see research.ts for the pattern's
 * rationale) — a zombie worker no-ops instead of clobbering newer state.
 */
export async function advanceProspectScan(
  supabase: DB,
  scanId: string,
): Promise<ProspectStepOutcome> {
  const lockCutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
  const { data: claimed } = await supabase
    .from("prospect_scans")
    .update({ locked_at: new Date().toISOString() })
    .eq("id", scanId)
    .in("status", [...CLAIMABLE])
    .or(`locked_at.is.null,locked_at.lt.${lockCutoff}`)
    .select("*");
  if (!claimed?.length) return "skipped";
  const scan = claimed[0] as ScanRow;
  const token = scan.locked_at;
  if (!token) return "skipped";

  // Carried across every analysis write (each step replaces the jsonb).
  const carry = (scan.analysis ?? {}) as Record<string, unknown>;

  const commit = async (patch: Record<string, unknown>) => {
    const merged =
      patch.analysis && typeof patch.analysis === "object"
        ? {
            ...patch,
            analysis: {
              ...carry,
              ...(patch.analysis as Record<string, unknown>),
            },
          }
        : patch;
    const { error } = await supabase
      .from("prospect_scans")
      .update({ ...merged, locked_at: null })
      .eq("id", scanId)
      .eq("locked_at", token);
    if (error) throw new Error(error.message);
  };

  const recount = () => scanCounts(supabase, scanId);

  try {
    if (scan.status === "pending" || scan.status === "searching") {
      await runSearch(supabase, scan);
      const counts = await recount();
      await commit({ status: "qualifying", ...counts, error: null });
      return "advanced";
    }

    if (scan.status === "qualifying") {
      // A queued Re-check-all takes priority: work through its ids in the
      // same small batches, then fall back to normal pending qualification.
      const recheckIds = Array.isArray(carry.recheckIds)
        ? (carry.recheckIds as string[])
        : [];
      if (recheckIds.length) {
        const rest = await runRecheckBatch(supabase, scan, recheckIds);
        const counts = await recount();
        await commit({
          status: "qualifying",
          ...counts,
          analysis: { recheckIds: rest },
        });
        return "advanced";
      }

      const remaining = await runQualifyBatch(supabase, scan);
      const counts = await recount();
      await commit({
        status: remaining ? "qualifying" : "drafting",
        ...counts,
      });
      return "advanced";
    }

    if (scan.status === "drafting") {
      const next = await runDraftStep(supabase, scan, carry);
      const counts = await recount();
      await commit({
        status: next.moveOn ? "importing" : "drafting",
        ...counts,
        ...(next.relevanceChecked ? { analysis: { relevanceChecked: true } } : {}),
      });
      return "advanced";
    }

    if (scan.status === "importing") {
      const imported = await runImport(supabase, scan);
      const counts = await recount();
      await commit({ status: "done", imported, ...counts, error: null });
      return "done";
    }

    // Terminal/unknown — release the lease (fenced).
    await supabase
      .from("prospect_scans")
      .update({ locked_at: null })
      .eq("id", scanId)
      .eq("locked_at", token);
    return "skipped";
  } catch (e) {
    console.error("[prospecting] step failed:", e);
    await supabase
      .from("prospect_scans")
      .update({
        status: "error",
        error: e instanceof Error ? e.message : "Scan failed.",
        locked_at: null,
      })
      .eq("id", scanId)
      .eq("locked_at", token);
    return "error";
  }
}

/** Refresh a scan's qualified/skipped counters from its candidate rows. */
async function scanCounts(
  supabase: DB,
  scanId: string,
): Promise<{ qualified: number; skipped: number }> {
  const [q, s] = await Promise.all([
    supabase
      .from("prospect_candidates")
      .select("*", { count: "exact", head: true })
      .eq("scan_id", scanId)
      .in("status", ["qualified", "imported", "emailed"]),
    supabase
      .from("prospect_candidates")
      .select("*", { count: "exact", head: true })
      .eq("scan_id", scanId)
      .eq("status", "skipped"),
  ]);
  return { qualified: q.count ?? 0, skipped: s.count ?? 0 };
}

// ---- STEP 1: search the area ---------------------------------------------------

async function runSearch(supabase: DB, scan: ScanRow): Promise<void> {
  if (!isProspectingConfigured()) {
    throw new Error(
      "Add GOOGLE_PLACES_API_KEY (recommended) or FIRECRAWL_API_KEY to run scans.",
    );
  }
  const categories = scan.categories.length ? scan.categories : ["businesses"];
  const area = `${scan.city}, ${scan.country}`;

  // Enumerate businesses category by category until the cap is met.
  const seen = new Set<string>();
  const businesses: (PlaceBusiness & { category: string })[] = [];
  let placesError = "";
  if (isPlacesConfigured()) {
    for (const category of categories) {
      if (businesses.length >= scan.max_results) break;
      const { businesses: found, error } = await placesSearchAll(
        `${category} in ${area}`,
        Math.min(60, scan.max_results - businesses.length),
      );
      if (error && !placesError) placesError = error;
      for (const b of found) {
        if (seen.has(b.placeId)) continue;
        seen.add(b.placeId);
        businesses.push({ ...b, category });
      }
    }
    // An API failure must never masquerade as "this area has no businesses" —
    // that is exactly what a key that's missing/restricted on the HOST (but
    // fine locally) looks like. Surface the real reason on the scan instead.
    if (!businesses.length && placesError) {
      throw new Error(
        `Google Places search failed: ${placesError} Check GOOGLE_PLACES_API_KEY in your hosting environment (Netlify → Site configuration → Environment variables — redeploy after changing it) and the key's restrictions in Google Cloud (IP/referrer restrictions block serverless hosts).`,
      );
    }
  } else {
    // Firecrawl-only fallback: web search can only surface businesses that
    // HAVE websites — "no website" discovery needs the Places key.
    const country = countryCode(scan.country);
    for (const category of categories) {
      if (businesses.length >= scan.max_results) break;
      const hits = await firecrawlSearch(`${category} in ${area}`, {
        limit: 10,
        withoutContent: true,
        ...(country ? { country } : {}),
      });
      for (const hit of hits) {
        const domain = domainOf(hit.url);
        if (!domain || isJunkCompetitorDomain(domain)) continue;
        const placeId = `web:${domain}`;
        if (seen.has(placeId)) continue;
        seen.add(placeId);
        businesses.push({
          placeId,
          name: cleanCompanyTitle(hit.title) || brandNameFromDomain(domain),
          address: "",
          phone: "",
          website: `https://${domain}`,
          rating: null,
          ratingCount: 0,
          types: [],
          businessStatus: "",
          category,
        });
        if (businesses.length >= scan.max_results) break;
      }
    }
    if (!businesses.length) {
      throw new Error(
        "Web search found no businesses for this area (GOOGLE_PLACES_API_KEY is not set, so the scan could only use Firecrawl web search — which also can't find businesses that have no website). Add GOOGLE_PLACES_API_KEY to your hosting environment and re-run the scan.",
      );
    }
  }

  // Never re-pitch someone already in the CRM. THIS is the check that protects
  // the prospect — the old global place_id index only hid businesses from the
  // operator (see 0059). Three ways to match, strongest first:
  //   1. prospect_place_id — the exact Google id stamped on every lead this
  //      agent imported. Unambiguous, and survives a rename.
  //   2. website domain.
  //   3. company/title name similarity.
  // Soft-deleted leads are excluded on purpose: if the owner binned a lead,
  // finding that business again is the desired behaviour, not a bug.
  const { data: leads } = await supabase
    .from("leads")
    .select("title, company, company_website, custom")
    .is("deleted_at", null);
  const leadPlaceIds = new Set(
    (leads ?? [])
      .map((l) => {
        const custom = (l.custom ?? {}) as Record<string, unknown>;
        return typeof custom.prospect_place_id === "string"
          ? custom.prospect_place_id
          : "";
      })
      .filter(Boolean),
  );
  const leadDomains = new Set(
    (leads ?? [])
      .map((l) => (l.company_website ? domainOf(l.company_website) : ""))
      .filter(Boolean),
  );
  const leadNames = (leads ?? [])
    .flatMap((l) => [l.company, l.title])
    .filter((n): n is string => Boolean(n?.trim()));

  const rows = businesses.map((b) => {
    const denied = b.types.some((t) => DENY_TYPES.has(t));
    const inCrm =
      leadPlaceIds.has(b.placeId) ||
      (b.website && leadDomains.has(domainOf(b.website))) ||
      leadNames.some((n) => sameCompany(n, b.name));
    const verdict: ProspectVerdict = denied
      ? "excluded"
      : inCrm
        ? "duplicate"
        : "pending";
    return {
      scan_id: scan.id,
      place_id: b.placeId,
      name: b.name,
      category: b.category,
      address: b.address,
      phone: b.phone,
      website: b.website,
      rating: b.rating,
      rating_count: b.ratingCount,
      website_verdict: verdict,
      status: verdict === "pending" ? ("pending" as const) : ("skipped" as const),
      reason:
        verdict === "excluded"
          ? "Institution/utility — a website pitch doesn't fit."
          : verdict === "duplicate"
            ? "Already in your CRM."
            : "",
    };
  });

  // How many of these has an EARLIER scan already looked at? Since 0059 that
  // no longer suppresses them — they're re-examined — but it's the honest
  // answer to "why did a re-scan of the same street turn up so little?", so
  // it's counted and shown rather than left invisible.
  const seenBefore = await countSeenByEarlierScans(
    supabase,
    scan.id,
    businesses.map((b) => b.placeId),
  );

  if (rows.length) {
    // Unique on (scan_id, place_id) since 0059 — this only collapses dupes
    // WITHIN this scan (the same business matching two categories). Businesses
    // seen by earlier scans are re-examined; not re-pitching them is handled
    // properly above by the CRM domain/name check → verdict 'duplicate'.
    const { error } = await supabase
      .from("prospect_candidates")
      .upsert(rows, { onConflict: "scan_id,place_id", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  }

  const { count } = await supabase
    .from("prospect_candidates")
    .select("*", { count: "exact", head: true })
    .eq("scan_id", scan.id);

  // The funnel, so the UI can explain the gap between "find 40" and what
  // actually lands in the CRM instead of just showing a smaller number.
  const funnel = {
    requested: scan.max_results,
    returned: businesses.length,
    seenBefore,
    excluded: rows.filter((r) => r.website_verdict === "excluded").length,
    duplicate: rows.filter((r) => r.website_verdict === "duplicate").length,
    examined: rows.filter((r) => r.website_verdict === "pending").length,
    ...(placesError ? { searchError: placesError.slice(0, 300) } : {}),
  };

  await supabase
    .from("prospect_scans")
    .update({
      found: count ?? 0,
      analysis: { ...((scan.analysis ?? {}) as object), funnel },
    })
    .eq("id", scan.id);
}

/**
 * How many of these businesses an EARLIER scan already covered.
 *
 * Counts DISTINCT place_ids, not rows: now that (scan_id, place_id) is the
 * unique key, several past scans can each hold a row for the same business, so
 * a row count would report more "already seen" businesses than were returned.
 * Chunked — `in()` on a few hundred ids blows the URL length.
 */
async function countSeenByEarlierScans(
  supabase: DB,
  scanId: string,
  placeIds: string[],
): Promise<number> {
  if (!placeIds.length) return 0;
  const seen = new Set<string>();
  for (let i = 0; i < placeIds.length; i += 100) {
    const chunk = placeIds.slice(i, i + 100);
    const { data } = await supabase
      .from("prospect_candidates")
      .select("place_id")
      .in("place_id", chunk)
      .neq("scan_id", scanId);
    for (const r of data ?? []) seen.add(r.place_id);
  }
  return seen.size;
}

// ---- STEP 2: qualify websites ----------------------------------------------------

/** Returns true while pending candidates remain (keep this step running). */
async function runQualifyBatch(supabase: DB, scan: ScanRow): Promise<boolean> {
  const { data: batch } = await supabase
    .from("prospect_candidates")
    .select("*")
    .eq("scan_id", scan.id)
    .eq("website_verdict", "pending")
    .order("created_at", { ascending: true })
    .limit(QUALIFY_BATCH);
  if (!batch?.length) return false;

  const country = countryCode(scan.country);
  // Two at a time — Firecrawl caps concurrent scrapes, and blowing through
  // the cap manufactures the null results that used to read as "site down".
  const results: CandidatePatch[] = [];
  for (let i = 0; i < batch.length; i += 2) {
    const chunk = (batch as CandidateRow[]).slice(i, i + 2);
    results.push(
      ...(await Promise.all(chunk.map((c) => qualifyOne(c, scan, country)))),
    );
  }

  for (let i = 0; i < batch.length; i++) {
    await supabase
      .from("prospect_candidates")
      .update(results[i])
      .eq("id", batch[i].id);
  }

  const { count } = await supabase
    .from("prospect_candidates")
    .select("*", { count: "exact", head: true })
    .eq("scan_id", scan.id)
    .eq("website_verdict", "pending");
  return (count ?? 0) > 0;
}

type CandidatePatch = {
  website_verdict: ProspectVerdict;
  status: "qualified" | "skipped";
  reason: string;
  website: string;
  score: number | null;
  issues: string[];
  emails: string[];
  contact_name: string;
};

/**
 * One Firecrawl scrape with a single retry — a null result is often a rate
 * limit or scrape timeout, not the site being down, and a second attempt a
 * moment later usually succeeds. (Local to prospecting; research behaviour
 * is untouched.)
 */
async function scrapeWithRetry(
  url: string,
  opts?: { html?: boolean },
): Promise<Awaited<ReturnType<typeof firecrawlScrape>>> {
  const first = await firecrawlScrape(url, opts);
  if (first) return first;
  await new Promise((r) => setTimeout(r, 1500));
  return firecrawlScrape(url, opts);
}

/** Visible-text length of raw HTML (for content-depth grading sans Firecrawl). */
function htmlTextLength(html: string): number {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

/**
 * Thin-content chars, SPA-guarded: a JavaScript-heavy site can render plenty
 * of content from a near-empty document, so when the text is thin but the
 * document is large we grade content depth as neutral instead of penalising.
 */
function guardedContentChars(textChars: number, htmlChars: number): number {
  return textChars < 500 && htmlChars > 30_000 ? 500 : textChars;
}

/** Emails that must never be a cold-outreach target. */
const JUNK_EMAIL_RE =
  /(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|abuse@|example\.|yourdomain|yoursite|sentry|wixpress|cloudflare|godaddy|privacyprotect|whoisguard|domainsbyproxy|\.png$|\.jpe?g$|\.webp$|\.gif$|\.svg$)/i;

/**
 * Clean + rank scraped emails so `emails[0]` (the Send target) is the best
 * one: junk dropped, the business's own domain first, generic inboxes
 * (info@/hello@…) before personal-looking ones on other domains.
 * Exported for the fixture tests.
 */
export function cleanProspectEmails(
  emails: string[],
  ownDomain: string,
): string[] {
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
    const own =
      ownDomain && (dom === ownDomain || dom.endsWith(`.${ownDomain}`));
    const generic = /^(info|hello|contact|sales|admin|office|mail|inquir|enquir)/i.test(
      e,
    );
    return (own ? 0 : 2) + (generic ? 0 : 1);
  };
  return cleaned.sort((a, b) => rank(a) - rank(b)).slice(0, 5);
}

/** Snippet-search for an email when there's no site to scrape. */
async function digEmailFromSearch(
  name: string,
  city: string,
  country: string,
): Promise<string[]> {
  const hits = await firecrawlSearch(`"${name}" ${city} email contact`, {
    limit: 4,
    withoutContent: true,
    ...(country ? { country } : {}),
  });
  const text = hits.map((h) => `${h.title} ${h.description}`).join("\n");
  return cleanProspectEmails(extractEmails(text), "").slice(0, 3);
}

async function qualifyOne(
  c: CandidateRow,
  scan: ScanRow,
  country: string,
): Promise<CandidatePatch> {
  const base: CandidatePatch = {
    website_verdict: "no_website",
    status: "qualified",
    reason: "",
    website: c.website,
    score: null,
    issues: [],
    emails: c.emails ?? [],
    contact_name: c.contact_name ?? "",
  };

  let website = c.website.trim();

  // A social/profile link is not a website — instant qualify, great pitch.
  if (website && SOCIAL_ONLY_RE.test(website)) {
    const emails = isFirecrawlConfigured()
      ? await digEmailFromSearch(c.name, scan.city, country)
      : [];
    return {
      ...base,
      website_verdict: "facebook_only",
      issues: [
        "Their only web presence is a social/profile page — no website of their own.",
        "Customers searching for them find a page they don't control.",
      ],
      emails,
    };
  }

  // Claimed no website → VERIFY with a web search before saying so (the
  // team must never email "you have no website" to someone who has one).
  if (!website && isFirecrawlConfigured()) {
    const hits = await firecrawlSearch(`"${c.name}" ${scan.city} website`, {
      limit: 4,
      withoutContent: true,
      ...(country ? { country } : {}),
    });
    for (const hit of hits) {
      const domain = domainOf(hit.url);
      if (!domain || isJunkCompetitorDomain(domain)) continue;
      const hitName = cleanCompanyTitle(hit.title) || brandNameFromDomain(domain);
      if (sameCompany(hitName, c.name) || sameCompany(brandNameFromDomain(domain), c.name)) {
        website = hit.url;
        break;
      }
    }
    if (!website) {
      const text = hits.map((h) => `${h.title} ${h.description}`).join("\n");
      return {
        ...base,
        website_verdict: "no_website",
        issues: [
          "No website found — invisible to customers searching online.",
          "Competitors with websites win the customers who research first.",
        ],
        emails: cleanProspectEmails(extractEmails(text), "").slice(0, 3),
      };
    }
  }

  if (!website) {
    // No site and no Firecrawl to verify/dig — qualify on Places data alone.
    return {
      ...base,
      website_verdict: "no_website",
      issues: ["No website registered on their Google Business listing."],
    };
  }

  // Has a website → scrape (with one retry) and grade it. A failed scrape is
  // NOT evidence the site is down — verify with a direct browser-style probe
  // before any negative verdict (a live site once got a false "Site down").
  const page = isFirecrawlConfigured()
    ? await scrapeWithRetry(website, { html: true })
    : null;

  // What we grade from: the Firecrawl render, or the probe's raw HTML.
  let html = "";
  let contentChars = 0;
  let pageUrl = website;
  let pageLinks: string[] = [];

  if (page) {
    html = page.html;
    pageUrl = page.url || website;
    pageLinks = page.links;
    contentChars = guardedContentChars(page.markdown.length, page.html.length);
  } else {
    const probe = await probeSite(website);
    if (probe.verdict === "up" && probe.html) {
      // Site is fine — the scraper was the problem. Grade the fetched HTML.
      html = probe.html;
      pageUrl = probe.finalUrl || website;
      contentChars = guardedContentChars(
        htmlTextLength(probe.html),
        probe.html.length,
      );
    } else if (probe.verdict === "up" || probe.verdict === "protected") {
      return {
        ...base,
        website,
        website_verdict: "unverified",
        status: "skipped",
        reason:
          "Site is up but couldn't be analyzed automatically — check it manually before pitching.",
      };
    } else if (probe.verdict === "erroring") {
      return {
        ...base,
        website,
        website_verdict: "broken",
        issues: [
          `Website responds with a server error (HTTP ${probe.status}) — visitors see a broken site.`,
        ],
      };
    } else {
      return {
        ...base,
        website,
        website_verdict: "broken",
        issues: [
          "Website is unreachable — confirmed by two independent checks (scraper + direct visit).",
        ],
      };
    }
  }

  const seo = analyzeSeo(html);
  const copyrightYear = extractCopyrightYear(html);
  const https = pageUrl.startsWith("https://");
  const { score, issues } = quickSiteVerdict({
    seo,
    https,
    copyrightYear,
    contentChars,
  });

  const ownDomain = domainOf(pageUrl);
  const facts = extractStructuredFacts(html);
  const emails = cleanProspectEmails(
    [...extractEmails(html), ...facts.emails],
    ownDomain,
  );
  const contact_name = facts.founders[0] ?? "";

  if (score >= scan.min_score) {
    return {
      ...base,
      website,
      website_verdict: "good_website",
      status: "skipped",
      score,
      emails,
      contact_name,
      reason: `Website looks fine (${score}/100) — not worth a pitch.`,
    };
  }

  // Bad website → qualified. If no email yet, try the contact page (1 scrape).
  let allEmails = emails;
  if (!allEmails.length && pageLinks.length && isFirecrawlConfigured()) {
    const contactUrl = pageLinks.find(
      (l) =>
        /contact|get-in-touch|reach-us|enquir|inquir/i.test(l) &&
        domainOf(l) === ownDomain,
    );
    if (contactUrl) {
      const contactPage = await firecrawlScrape(contactUrl);
      if (contactPage) {
        allEmails = cleanProspectEmails(
          extractEmails(contactPage.markdown),
          ownDomain,
        );
      }
    }
  }

  return {
    ...base,
    website,
    website_verdict: "bad_website",
    score,
    issues,
    emails: allEmails,
    contact_name,
  };
}

// ---- STEP 3: relevance pass + cold-outreach drafts -------------------------------

function str(x: unknown): string {
  return typeof x === "string" ? x.trim() : "";
}

/** Deterministic drafts when OpenAI is unavailable or skips a candidate. */
function templateDrafts(c: CandidateRow, city: string): {
  subject: string;
  body: string;
  sms: string;
} {
  const noSite =
    c.website_verdict === "no_website" || c.website_verdict === "facebook_only";
  const hook = noSite
    ? `we noticed ${c.name} doesn't have its own website yet`
    : `we took a look at your website and noticed a few things holding it back${
        c.issues.length ? ` (${c.issues[0].replace(/\.$/, "").toLowerCase()})` : ""
      }`;
  const body = `Hi ${c.contact_name || `${c.name} team`},

We're ARC AI, a web design & digital agency, and ${hook}. For a business in ${city}, that usually means customers who search online end up with a competitor instead.

We build fast, modern, mobile-friendly websites that turn searches into enquiries. If you'd like, we can send over a free 5-minute breakdown of what we'd improve — no strings attached.

Would a quick call this week work?

Best regards,
ARC AI`;
  return {
    subject: noSite
      ? `A website for ${c.name}?`
      : `Quick thoughts on the ${c.name} website`,
    body,
    sms: `Hi from ARC AI! ${
      noSite
        ? `We noticed ${c.name} has no website yet - customers searching online can't find you.`
        : `We reviewed ${c.name}'s website and found a few issues costing you customers.`
    } We build modern, mobile-friendly sites. Reply or call us for a free breakdown.`,
  };
}

/** Returns whether to move on to importing, and whether relevance just ran. */
async function runDraftStep(
  supabase: DB,
  scan: ScanRow,
  carry: Record<string, unknown>,
): Promise<{ moveOn: boolean; relevanceChecked: boolean }> {
  const { data: qualified } = await supabase
    .from("prospect_candidates")
    .select("*")
    .eq("scan_id", scan.id)
    .eq("status", "qualified")
    .order("created_at", { ascending: true });
  const all = (qualified ?? []) as CandidateRow[];
  if (!all.length) return { moveOn: true, relevanceChecked: false };

  // One batched relevance pass: kill chains/institutions the deny-list missed
  // ("a website pitch wouldn't fit"). Conservative — when unsure, keep.
  if (!carry.relevanceChecked && isOpenAIConfigured()) {
    try {
      const listing = all
        .map(
          (c) =>
            `- id:${c.id} | ${c.name} | ${c.category} | ${c.website_verdict}${
              c.rating ? ` | ${c.rating}★ (${c.rating_count})` : ""
            }`,
        )
        .join("\n");
      const raw = await openaiChatJSON(
        [
          {
            role: "system",
            content:
              "You vet cold-outreach prospects for a web design agency. Drop ONLY clearly bad fits: global/franchise chains, government or public institutions, or businesses where a website pitch makes no sense. Independent local businesses are GOOD prospects — when unsure, keep. Return JSON only.",
          },
          {
            role: "user",
            content: `Prospects in ${scan.city}, ${scan.country}:\n${listing}\n\nReturn {"drop":[{"id":"...","reason":"one short line"}]} — drop only clear misfits.`,
          },
        ],
        { model: MODEL, reasoningEffort: "low", timeoutMs: 60_000 },
      );
      const parsed = JSON.parse(raw) as {
        drop?: { id?: string; reason?: string }[];
      };
      const validIds = new Set(all.map((c) => c.id));
      for (const d of parsed.drop ?? []) {
        const id = str(d.id);
        if (!id || !validIds.has(id)) continue;
        await supabase
          .from("prospect_candidates")
          .update({
            status: "skipped",
            website_verdict: "excluded",
            reason: str(d.reason) || "Not a realistic web-design prospect.",
          })
          .eq("id", id)
          .eq("scan_id", scan.id);
      }
    } catch (e) {
      // Relevance is a refinement, not a gate — never fail the scan on it.
      console.error("[prospecting] relevance pass failed:", e);
    }
    return { moveOn: false, relevanceChecked: true };
  }

  // Draft the next batch of cold emails + SMS.
  const batch = all.filter((c) => !c.draft_body).slice(0, DRAFT_BATCH);
  if (!batch.length) return { moveOn: true, relevanceChecked: false };

  let drafted = new Map<string, { subject: string; body: string; sms: string }>();
  if (isOpenAIConfigured()) {
    try {
      const listing = batch
        .map((c) =>
          [
            `id: ${c.id}`,
            `business: ${c.name} (${c.category}, ${scan.city})`,
            `situation: ${c.website_verdict}${c.score !== null ? ` — site scored ${c.score}/100` : ""}`,
            c.issues.length ? `issues: ${c.issues.join(" | ")}` : "",
            c.rating ? `google rating: ${c.rating}★ from ${c.rating_count} reviews` : "",
            c.contact_name ? `owner/contact: ${c.contact_name}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        )
        .join("\n\n");
      const raw = await openaiChatJSON(
        [
          {
            role: "system",
            content: `You write cold outreach for ARC AI, a web design & digital agency. For EACH prospect write:
- "subject": under 60 chars, specific, no clickbait, no emoji.
- "body": a plain-text email, 90-130 words. Open with something SPECIFIC to them (their rating, their missing/weak website, a real issue from the list). Plainly state what it's costing them locally. One-line offer: a free, no-obligation breakdown of what we'd improve. Soft CTA (quick call or reply). Sign off "Best regards,\\nARC AI". Never invent facts. Greet the owner by name when given, else "Hi <business> team".
- "sms": under 300 characters, GSM-friendly (plain apostrophes/hyphens, no emoji), same specific hook, starts "Hi from ARC AI", ends asking them to reply or call.
Return JSON only: {"drafts":[{"id","subject","body","sms"}]}.`,
          },
          { role: "user", content: listing },
        ],
        { model: MODEL, reasoningEffort: "low", timeoutMs: 90_000 },
      );
      const parsed = JSON.parse(raw) as {
        drafts?: { id?: string; subject?: string; body?: string; sms?: string }[];
      };
      drafted = new Map(
        (parsed.drafts ?? [])
          .filter((d) => str(d.id) && str(d.body))
          .map((d) => [
            str(d.id),
            {
              subject: str(d.subject).slice(0, 120),
              body: str(d.body).slice(0, 2000),
              sms: str(d.sms).slice(0, 400),
            },
          ]),
      );
    } catch (e) {
      console.error("[prospecting] drafting failed, using templates:", e);
    }
  }

  // Anything the model missed gets the deterministic template — a candidate
  // must never stay draftless or this step would loop forever.
  for (const c of batch) {
    const d = drafted.get(c.id) ?? templateDrafts(c, scan.city);
    await supabase
      .from("prospect_candidates")
      .update({
        draft_subject: d.subject || templateDrafts(c, scan.city).subject,
        draft_body: d.body,
        draft_sms: d.sms,
      })
      .eq("id", c.id);
  }

  const remaining = all.filter((c) => !c.draft_body).length - batch.length;
  return { moveOn: remaining <= 0, relevanceChecked: false };
}

// ---- STEP 4: import into the CRM --------------------------------------------------

function buildLeadNotes(c: CandidateRow): string {
  const lines = [
    c.website_verdict === "no_website"
      ? "Prospecting: no website found."
      : c.website_verdict === "facebook_only"
        ? "Prospecting: social-page-only presence (no real website)."
        : c.website_verdict === "broken"
          ? "Prospecting: website down/unreachable."
          : `Prospecting: weak website — scored ${c.score ?? "?"}/100.`,
    c.address ? `Address: ${c.address}` : "",
    c.rating ? `Google rating: ${c.rating}★ (${c.rating_count} reviews)` : "",
    c.issues.length ? `\nWebsite issues:\n${c.issues.map((i) => `• ${i}`).join("\n")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

async function runImport(supabase: DB, scan: ScanRow): Promise<number> {
  const { data: qualified } = await supabase
    .from("prospect_candidates")
    .select("*")
    .eq("scan_id", scan.id)
    .eq("status", "qualified")
    .is("lead_id", null)
    .order("created_at", { ascending: true });
  const candidates = (qualified ?? []) as CandidateRow[];
  const { count: alreadyImported } = await supabase
    .from("prospect_candidates")
    .select("*", { count: "exact", head: true })
    .eq("scan_id", scan.id)
    .in("status", ["imported", "emailed"]);
  if (!candidates.length) return alreadyImported ?? 0;

  // Destination: the scan's pick, else the first pipeline's first stage.
  let pipelineId = scan.pipeline_id;
  let stageId = scan.stage_id;
  if (!pipelineId || !stageId) {
    const { data: pipeline } = await supabase
      .from("pipelines")
      .select("id")
      .order("position", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!pipeline) throw new Error("Create a CRM pipeline before importing leads.");
    pipelineId = pipelineId ?? pipeline.id;
    if (!stageId) {
      const { data: stage } = await supabase
        .from("pipeline_stages")
        .select("id")
        .eq("pipeline_id", pipelineId)
        .order("position", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (!stage) throw new Error("The destination pipeline has no stages.");
      stageId = stage.id;
    }
  }

  // Prospected leads land as a block at the top of their stage column, above
  // everything already there.
  let position = await topLeadPosition(supabase, stageId, candidates.length);

  const cityTag = scan.city.trim();
  const createdLeads: LeadRow[] = [];
  // Candidate context per lead — the cold first-touch template's variables.
  const candidateByLead = new Map<string, CandidateRow>();
  // Auto-draft AI outreach for each new lead (gated on the global toggle).
  const { enabled: outreachEnabled } = await outreachSettings(supabase);

  for (const c of candidates) {
    const { data: lead, error } = await supabase
      .from("leads")
      .insert({
        pipeline_id: pipelineId,
        stage_id: stageId,
        title: c.name,
        company: c.name,
        contact_name: c.contact_name || null,
        contact_email: c.emails[0] ?? null,
        contact_phone: c.phone || null,
        company_website: c.website || null,
        notes: buildLeadNotes(c),
        tags: [cityTag, "prospecting"].filter(Boolean),
        source: "prospecting",
        custom: {
          prospect_place_id: c.place_id,
          prospect_score: c.score,
          prospect_verdict: c.website_verdict,
          // The full scraped list — the outreach pipeline emails ALL of them.
          prospect_emails: c.emails,
        },
        position: position++,
      })
      .select("*")
      .single();
    if (error || !lead) {
      console.error("[prospecting] lead insert failed:", error?.message);
      continue;
    }
    createdLeads.push(lead as LeadRow);
    candidateByLead.set(lead.id, c);

    await supabase.from("prospect_candidates").update({
      status: "imported",
      lead_id: lead.id,
    }).eq("id", c.id);

    // The drafts travel with the lead so the team works from the lead card.
    if (c.draft_body) {
      await supabase.from("lead_activities").insert({
        lead_id: lead.id,
        kind: "note",
        title: `Cold outreach draft: ${c.draft_subject || "email"}`,
        body: `${c.draft_body}${c.draft_sms ? `\n\n— SMS version —\n${c.draft_sms}` : ""}`,
      });
    }

    // Queue an AI-researched, audit-personalized outreach draft (approve-to-send).
    if (outreachEnabled) {
      await enqueueLeadOutreach(supabase, {
        leadId: lead.id,
        recipients: c.emails,
        source: "prospecting",
      });
    }
  }

  if (scan.fire_automations) {
    for (const lead of createdLeads) {
      const c = candidateByLead.get(lead.id);
      await fireAutomationTrigger(supabase, {
        trigger: "lead_created",
        lead,
        // Cold first-touch template variables: {{business}}, {{audit_score}},
        // {{top_issue}}, {{city}} all render from this context.
        payload: {
          business: lead.company ?? lead.title,
          audit_score: c?.score != null ? String(c.score) : "",
          top_issue: c?.issues?.[0] ?? "",
          city: cityTag,
        },
        triggerKey: `${lead.id}:created`,
      });
    }
  } else if (createdLeads.length) {
    // Consume each lead_created dedupe key with a cancelled run so the tick
    // scanner can't enroll cold prospects into inbound keep-warm flows
    // (mirrors importLeads in crm/actions.ts).
    const { data: automations } = await supabase
      .from("automations")
      .select("id")
      .eq("trigger", "lead_created");
    for (const automation of automations ?? []) {
      await supabase.from("automation_runs").insert(
        createdLeads.map((lead) => ({
          automation_id: automation.id,
          lead_id: lead.id,
          trigger_key: `${lead.id}:created`,
          status: "cancelled" as const,
          subject_name: "",
          completed_at: new Date().toISOString(),
        })),
      );
    }
  }

  return (alreadyImported ?? 0) + createdLeads.length;
}

// ---- per-candidate re-check --------------------------------------------------------

/**
 * Re-run the full qualification ladder for ONE candidate, on demand (the
 * "Re-check" button). Fixes false verdicts in one click: fresh scrape with
 * retry, direct probe, re-grade, contact re-dig. Updates the candidate, the
 * scan's counters, and — when the candidate is already a CRM lead and the
 * verdict changed — leaves an honest note on the lead. A wrongly-skipped
 * candidate that now qualifies on a finished scan is handed back to the
 * pipeline's drafting step so it gets a pitch and a lead like any other.
 */
export async function requalifyCandidate(
  supabase: DB,
  candidateId: string,
): Promise<
  { ok: true; verdict: ProspectVerdict } | { ok: false; error: string }
> {
  const { data: c } = await supabase
    .from("prospect_candidates")
    .select("*")
    .eq("id", candidateId)
    .maybeSingle();
  if (!c) return { ok: false, error: "Prospect not found." };
  const candidate = c as CandidateRow;

  const { data: s } = await supabase
    .from("prospect_scans")
    .select("*")
    .eq("id", candidate.scan_id)
    .maybeSingle();
  if (!s) return { ok: false, error: "The prospect's scan no longer exists." };
  const scan = s as ScanRow;

  const patch = await qualifyOne(
    { ...candidate, website_verdict: "pending", score: null, issues: [] },
    scan,
    countryCode(scan.country),
  );

  const applied = await applyRequalifyResult(supabase, candidate, patch);
  if (!applied.ok) return { ok: false, error: applied.error };

  const counts = await scanCounts(supabase, candidate.scan_id);
  await supabase
    .from("prospect_scans")
    .update(counts)
    .eq("id", candidate.scan_id);

  // Finished scan + a qualified candidate needing a draft/lead → re-open the
  // pipeline at drafting; the caller drains it so this completes right away.
  if (scan.status === "done" && applied.needsRedraft) {
    await supabase
      .from("prospect_scans")
      .update({ status: "drafting", locked_at: null })
      .eq("id", candidate.scan_id);
  }

  return { ok: true, verdict: patch.website_verdict };
}

/**
 * Write a fresh qualification result over an EXISTING verdict, preserving the
 * candidate's history: contacted/imported candidates keep that status while
 * they still qualify, a verdict change on a lead gets an honest note, and a
 * changed verdict clears the now-stale pitch (never for sent outreach) so the
 * drafting step rewrites it. Shared by the single Re-check and Re-check-all.
 */
async function applyRequalifyResult(
  supabase: DB,
  candidate: CandidateRow,
  patch: CandidatePatch,
): Promise<{ ok: true; needsRedraft: boolean } | { ok: false; error: string; needsRedraft: boolean }> {
  const prevVerdict = candidate.website_verdict;

  const keepContacted =
    (candidate.status === "imported" || candidate.status === "emailed") &&
    patch.status === "qualified";
  const status = keepContacted ? candidate.status : patch.status;

  const needsRedraft =
    patch.status === "qualified" &&
    candidate.status !== "emailed" &&
    (patch.website_verdict !== prevVerdict || !candidate.draft_body);

  const { error } = await supabase
    .from("prospect_candidates")
    .update({
      ...patch,
      status,
      ...(needsRedraft
        ? { draft_subject: "", draft_body: "", draft_sms: "" }
        : {}),
    })
    .eq("id", candidate.id);
  if (error) return { ok: false, error: error.message, needsRedraft: false };

  if (candidate.lead_id && patch.website_verdict !== prevVerdict) {
    await supabase.from("lead_activities").insert({
      lead_id: candidate.lead_id,
      kind: "note",
      title: "Prospect re-checked",
      body: `Verdict changed: ${prevVerdict} → ${patch.website_verdict}${
        patch.score !== null ? ` (site scored ${patch.score}/100)` : ""
      }.${
        patch.status === "skipped"
          ? " Review whether this lead is still worth pursuing."
          : ""
      }`,
    });
  }

  return { ok: true, needsRedraft };
}

// ---- bulk re-check (Re-check all) ---------------------------------------------------

/** Verdicts that came from scrape/search calls and can therefore be wrong. */
const RECHECKABLE_VERDICTS: ProspectVerdict[] = [
  "no_website",
  "facebook_only",
  "bad_website",
  "broken",
  "good_website",
  "unverified",
];

/**
 * Queue EVERY scrape-dependent verdict in a scan for a fresh run through the
 * verification ladder. The ids ride in `analysis.recheckIds` and the scan
 * re-enters `qualifying`, so the existing pipeline (inline drain + minute
 * tick + page poll) chews through them in small batches with crash-resume —
 * a hundred candidates never have to fit one request. Only callable between
 * runs; the drafting/import steps then rewrite stale pitches and import any
 * newly-qualified candidates exactly like a normal scan.
 */
export async function queueScanRecheck(
  supabase: DB,
  scanId: string,
): Promise<{ ok: true; queued: number } | { ok: false; error: string }> {
  const { data: s } = await supabase
    .from("prospect_scans")
    .select("*")
    .eq("id", scanId)
    .maybeSingle();
  if (!s) return { ok: false, error: "Scan not found." };
  const scan = s as ScanRow;
  if (scan.status !== "done" && scan.status !== "error") {
    return { ok: false, error: "The scan is still running — let it finish first." };
  }

  const { data: rows } = await supabase
    .from("prospect_candidates")
    .select("id")
    .eq("scan_id", scanId)
    .in("website_verdict", RECHECKABLE_VERDICTS);
  const ids = (rows ?? []).map((r) => r.id);
  if (!ids.length) {
    return { ok: false, error: "Nothing here needs re-checking." };
  }

  const analysis = {
    ...((scan.analysis ?? {}) as Record<string, unknown>),
    recheckIds: ids,
  };
  const { error } = await supabase
    .from("prospect_scans")
    .update({ status: "qualifying", analysis, locked_at: null, error: null })
    .eq("id", scanId)
    // Guard against a double-click racing two queues onto the same scan.
    .in("status", ["done", "error"]);
  if (error) return { ok: false, error: error.message };

  return { ok: true, queued: ids.length };
}

/**
 * Work through the queued re-check ids, QUALIFY_BATCH at a time (2 concurrent,
 * like first-pass qualification). Returns the ids still waiting.
 */
async function runRecheckBatch(
  supabase: DB,
  scan: ScanRow,
  ids: string[],
): Promise<string[]> {
  const batchIds = ids.slice(0, QUALIFY_BATCH);
  const { data: rows } = await supabase
    .from("prospect_candidates")
    .select("*")
    .in("id", batchIds);
  const batch = (rows ?? []) as CandidateRow[];
  const country = countryCode(scan.country);

  for (let i = 0; i < batch.length; i += 2) {
    const chunk = batch.slice(i, i + 2);
    const patches = await Promise.all(
      chunk.map((c) =>
        qualifyOne(
          { ...c, website_verdict: "pending", score: null, issues: [] },
          scan,
          country,
        ),
      ),
    );
    for (let j = 0; j < chunk.length; j++) {
      await applyRequalifyResult(supabase, chunk[j], patches[j]);
    }
  }

  return ids.slice(QUALIFY_BATCH);
}

// ---------------------------------------------------------------------------
// Recurring scan schedules (0049) — the hunter-closer's discovery cadence
// ---------------------------------------------------------------------------

/**
 * Launch a prospect scan for every due, active schedule. Called from the
 * automation tick. Claiming is fenced on next_run_at (compare-and-swap), so
 * overlapping ticks can never double-launch the same occurrence. The scan
 * itself then runs through the normal pending → … → done pipeline; when
 * auto_outreach is on, the scan fires lead_created automations on import —
 * which is what sends the cold first-touch WhatsApp template.
 */
export async function processDueProspectSchedules(supabase: DB): Promise<number> {
  const { data: due } = await supabase
    .from("prospect_scan_schedules")
    .select("*")
    .eq("is_active", true)
    .lte("next_run_at", new Date().toISOString())
    .limit(3);
  if (!due?.length) return 0;

  let started = 0;
  for (const schedule of due) {
    // Claim this occurrence: bump next_run_at first, fenced on its old value.
    const next = new Date(
      Date.now() + Math.max(1, schedule.cadence_days) * 86400_000,
    ).toISOString();
    const { data: claimed } = await supabase
      .from("prospect_scan_schedules")
      .update({ next_run_at: next })
      .eq("id", schedule.id)
      .eq("next_run_at", schedule.next_run_at)
      .select("id");
    if (!claimed?.length) continue;

    const categories = schedule.category
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean)
      .slice(0, 12);
    const { data: scan, error } = await supabase
      .from("prospect_scans")
      .insert({
        country: "Sri Lanka",
        city: schedule.area,
        categories: categories.length ? categories : [schedule.category],
        max_results: Math.min(Math.max(schedule.max_results, 5), 120),
        min_score: Math.min(Math.max(schedule.threshold, 20), 90),
        fire_automations: schedule.auto_outreach,
        analysis: { runStartedAt: Date.now(), schedule_id: schedule.id },
        created_by: schedule.created_by,
      })
      .select("id")
      .single();
    if (error || !scan) {
      console.error("[prospecting] scheduled scan launch failed:", error?.message);
      continue;
    }

    await supabase
      .from("prospect_scan_schedules")
      .update({ last_scan_id: scan.id })
      .eq("id", schedule.id);
    started += 1;
  }
  return started;
}
