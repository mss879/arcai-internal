import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import {
  fetchAsInlineImage,
  generateImage,
  isGeminiConfigured,
  type InlineImage,
} from "@/lib/ai/gemini";
import { runPageSpeed } from "@/lib/ai/pagespeed";
import { appLink } from "@/lib/app-url";
import { STORAGE_BUCKETS } from "@/lib/constants";
import { sendPushToUser } from "@/lib/push";
import { sendWhatsAppImage, sendWhatsAppText } from "@/lib/whatsapp";

type DB = SupabaseClient<Database>;
type ShowcaseRow = Database["public"]["Tables"]["wa_showcases"]["Row"];

/**
 * Live sales showcases — the WhatsApp agent's "show, don't tell" move.
 *
 * A showcase is ONE deliverable: a personalized public page (audit scores +
 * a Nano Banana 2 redesign mockup of the prospect's own homepage, before/
 * after) announced in the chat by ONE image message whose caption carries
 * the link. Built by the automation tick, one lease-fenced step per pass
 * (the exact carousels pattern):
 *
 *   pending   → gather: audit scores + Lighthouse screenshot ("before"),
 *               research summary, booking link, business WhatsApp number
 *   rendering → generate the redesign mockup with Gemini (Nano Banana 2)
 *   ready     → send the chat message, notify the team
 *   sent      ✓
 */

const LOCK_TTL_MS = 3 * 60 * 1000;
const MAX_STEP_FAILS = 3;

/** Nano Banana 2 — try GA first, fall back to the preview id. */
const MOCKUP_MODELS = ["gemini-3.1-flash-image", "gemini-3.1-flash-image-preview"];

const CLAIMABLE: Database["public"]["Tables"]["wa_showcases"]["Row"]["status"][] = [
  "pending",
  "rendering",
  "ready",
];

export type ShowcasePayload = {
  business: string;
  url: string;
  scores: {
    performance?: number;
    seo?: number;
    accessibility?: number;
    best_practices?: number;
    quick_score?: number;
  };
  issues: string[];
  summary: string;
  whatsapp_number: string | null;
  booking_url: string | null;
};

// ---------------------------------------------------------------------------
// Queueing (called by the agent's send_showcase tool)
// ---------------------------------------------------------------------------

export async function queueWaShowcase(
  supabase: DB,
  opts: { contactId: string; leadId: string | null; url: string; business: string },
): Promise<{ ok: boolean; token?: string; error?: string }> {
  // One in-flight showcase per contact — re-offer the existing one.
  const { data: existing } = await supabase
    .from("wa_showcases")
    .select("id, token, status")
    .eq("contact_id", opts.contactId)
    .in("status", ["pending", "rendering", "ready"])
    .limit(1)
    .maybeSingle();
  if (existing) return { ok: true, token: existing.token };

  const { data, error } = await supabase
    .from("wa_showcases")
    .insert({
      contact_id: opts.contactId,
      lead_id: opts.leadId,
      config: { url: opts.url, business: opts.business },
    })
    .select("token")
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not queue the showcase." };
  }
  return { ok: true, token: data.token };
}

// ---------------------------------------------------------------------------
// Tick worker
// ---------------------------------------------------------------------------

export type ShowcaseTickResult = { processed: number; failed: number };

export async function processPendingWaShowcases(
  supabase: DB,
  limit = 1,
): Promise<ShowcaseTickResult> {
  const result: ShowcaseTickResult = { processed: 0, failed: 0 };

  const lockCutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
  const { data: rows } = await supabase
    .from("wa_showcases")
    .select("id")
    .in("status", CLAIMABLE)
    .or(`locked_at.is.null,locked_at.lt.${lockCutoff}`)
    .order("updated_at", { ascending: true })
    .limit(Math.max(1, limit));
  if (!rows?.length) return result;

  for (const row of rows) {
    const outcome = await advanceWaShowcase(supabase, row.id);
    if (outcome === "advanced" || outcome === "done") result.processed += 1;
    else if (outcome === "error") result.failed += 1;
  }
  return result;
}

type StepOutcome = "advanced" | "done" | "error" | "skipped";

async function advanceWaShowcase(supabase: DB, id: string): Promise<StepOutcome> {
  const lockCutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
  const { data: claimed } = await supabase
    .from("wa_showcases")
    .update({ locked_at: new Date().toISOString() })
    .eq("id", id)
    .in("status", CLAIMABLE)
    .or(`locked_at.is.null,locked_at.lt.${lockCutoff}`)
    .select("*");
  if (!claimed?.length) return "skipped";
  const row = claimed[0];
  const token = row.locked_at;
  if (!token) return "skipped";

  const commit = async (patch: Database["public"]["Tables"]["wa_showcases"]["Update"]) => {
    const { error } = await supabase
      .from("wa_showcases")
      .update({ ...patch, locked_at: null })
      .eq("id", id)
      .eq("locked_at", token);
    if (error) throw new Error(error.message);
  };

  try {
    if (row.status === "pending") {
      const { payload, beforeUrl } = await gatherShowcase(supabase, row);
      await commit({
        status: "rendering",
        payload: payload as unknown as Record<string, unknown>,
        before_image_url: beforeUrl,
        error: null,
        attempts: 0,
      });
      return "advanced";
    }

    if (row.status === "rendering") {
      const mockupUrl = await renderMockup(supabase, row);
      await commit({
        status: "ready",
        mockup_image_url: mockupUrl,
        error: null,
        attempts: 0,
      });
      return "advanced";
    }

    if (row.status === "ready") {
      await deliverShowcase(supabase, row);
      await commit({ status: "sent", error: null, attempts: 0 });
      return "done";
    }

    await supabase
      .from("wa_showcases")
      .update({ locked_at: null })
      .eq("id", id)
      .eq("locked_at", token);
    return "skipped";
  } catch (e) {
    console.error("[wa-showcase] step failed:", e);
    const message = e instanceof Error ? e.message : "Showcase step failed.";
    const attempts = (row.attempts ?? 0) + 1;
    await supabase
      .from("wa_showcases")
      .update(
        attempts >= MAX_STEP_FAILS
          ? { status: "error", error: message, attempts, locked_at: null }
          : { attempts, locked_at: null },
      )
      .eq("id", id)
      .eq("locked_at", token);
    return attempts >= MAX_STEP_FAILS ? "error" : "advanced";
  }
}

// ---------------------------------------------------------------------------
// Step 1 — gather everything the page needs
// ---------------------------------------------------------------------------

async function gatherShowcase(
  supabase: DB,
  row: ShowcaseRow,
): Promise<{ payload: ShowcasePayload; beforeUrl: string | null }> {
  const cfg = (row.config ?? {}) as { url?: string; business?: string };
  const url = String(cfg.url ?? "").trim();
  const business = String(cfg.business ?? "").trim() || "your business";
  if (!url) throw new Error("Showcase has no website URL.");

  const payload: ShowcasePayload = {
    business,
    url,
    scores: {},
    issues: [],
    summary: "",
    whatsapp_number: null,
    booking_url: null,
  };

  // Lead context: the quick audit's issues live on the lead's activity log,
  // and research leaves an AI summary on the lead itself.
  if (row.lead_id) {
    const { data: lead } = await supabase
      .from("leads")
      .select("ai_summary, notes, company")
      .eq("id", row.lead_id)
      .maybeSingle();
    if (lead?.ai_summary) payload.summary = lead.ai_summary.slice(0, 500);
    const { data: audits } = await supabase
      .from("lead_activities")
      .select("title, body")
      .eq("lead_id", row.lead_id)
      .like("title", "Website audit%")
      .order("created_at", { ascending: false })
      .limit(1);
    const auditBody = audits?.[0]?.body ?? "";
    if (auditBody && auditBody !== "No major issues found.") {
      payload.issues = auditBody.split("\n").filter(Boolean).slice(0, 6);
    }
    const quick = audits?.[0]?.title.match(/(\d+)\/100/);
    if (quick) payload.scores.quick_score = Number(quick[1]);

    const { data: research } = await supabase
      .from("lead_research")
      .select("status, report")
      .eq("lead_id", row.lead_id)
      .maybeSingle();
    if (research?.status === "done" && !payload.summary) {
      const report = research.report as Record<string, unknown>;
      const firstString = ["summary", "overview", "aboutCompany", "about"]
        .map((k) => report?.[k])
        .find((v) => typeof v === "string" && v.length > 40) as string | undefined;
      if (firstString) payload.summary = firstString.slice(0, 500);
    }
  }

  // Real Lighthouse pass — scores + the "before" screenshot.
  let beforeUrl: string | null = null;
  const psi = await runPageSpeed(url);
  if (psi) {
    if (psi.performance >= 0) payload.scores.performance = psi.performance;
    if (psi.seo >= 0) payload.scores.seo = psi.seo;
    if (psi.accessibility >= 0) payload.scores.accessibility = psi.accessibility;
    if (psi.bestPractices >= 0) payload.scores.best_practices = psi.bestPractices;
    for (const audit of psi.failedAudits.slice(0, 4)) {
      if (!payload.issues.includes(audit)) payload.issues.push(audit);
    }
    if (psi.screenshot) {
      beforeUrl = await uploadDataUri(supabase, psi.screenshot, `${row.id}/before`);
    }
  }

  // CTAs: booking link + the business's own WhatsApp number (via Graph).
  const { data: link } = await supabase
    .from("meeting_links")
    .select("slug")
    .eq("active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (link) payload.booking_url = appLink(`/book/${link.slug}`);
  payload.whatsapp_number = await businessWaNumber();

  return { payload, beforeUrl };
}

/** The business's own display number (digits) for the page's wa.me CTA. */
async function businessWaNumber(): Promise<string | null> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  const pnid = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!token || !pnid) return null;
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${pnid}?fields=display_phone_number`,
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      },
    );
    const json = (await res.json().catch(() => null)) as {
      display_phone_number?: string;
    } | null;
    const digits = json?.display_phone_number?.replace(/[^\d]/g, "");
    return digits || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 2 — the Nano Banana 2 redesign mockup
// ---------------------------------------------------------------------------

async function renderMockup(supabase: DB, row: ShowcaseRow): Promise<string | null> {
  // No Gemini key → ship the showcase audit-only rather than never.
  if (!isGeminiConfigured()) return null;

  const payload = (row.payload ?? {}) as Partial<ShowcasePayload>;
  const business = payload.business || "the business";

  const references: InlineImage[] = [];
  if (row.before_image_url) {
    try {
      references.push(await fetchAsInlineImage(row.before_image_url));
    } catch {
      // Reference is a bonus, not a requirement.
    }
  }

  const prompt = [
    `Premium homepage redesign concept for "${business}" (${payload.url ?? "their website"}).`,
    `A photorealistic desktop-browser mockup of a stunning modern landing page: bold hero section featuring the business name "${business}", confident headline, professional photography, clean spacious layout, modern typography, a clear call-to-action button, subtle trust signals.`,
    payload.summary
      ? `About the business (reflect this in imagery and copy): ${payload.summary.slice(0, 300)}`
      : "",
    references.length
      ? "The attached image is their CURRENT website — keep the brand's identity (name, colours, subject matter) but make the design dramatically more premium and modern."
      : "",
    "Style: award-winning web design portfolio shot, soft shadows, cohesive colour palette, ultra-clean. No watermarks.",
  ]
    .filter(Boolean)
    .join("\n");

  let lastError: unknown = null;
  for (const model of MOCKUP_MODELS) {
    try {
      const image = await generateImage({
        prompt,
        references,
        aspectRatio: "16:9",
        imageSize: "2K",
        model,
      });
      const dataUri = `data:${image.mimeType};base64,${image.data}`;
      return await uploadDataUri(supabase, dataUri, `${row.id}/mockup`);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Mockup generation failed.");
}

async function uploadDataUri(
  supabase: DB,
  dataUri: string,
  basePath: string,
): Promise<string> {
  const match = dataUri.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!match) throw new Error("Invalid image data.");
  const [, mimeType, b64] = match;
  const ext = mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "png";
  const path = `${basePath}.${ext}`;
  const { error } = await supabase.storage
    .from(STORAGE_BUCKETS.waShowcases)
    .upload(path, Buffer.from(b64, "base64"), { contentType: mimeType, upsert: true });
  if (error) throw new Error(error.message);
  const { data } = supabase.storage.from(STORAGE_BUCKETS.waShowcases).getPublicUrl(path);
  return data.publicUrl;
}

// ---------------------------------------------------------------------------
// Step 3 — deliver: ONE chat message
// ---------------------------------------------------------------------------

/** Squash a pitch-ready issue line into a short mid-sentence phrase. */
function shortIssue(issue: string): string {
  const head = issue.split(" — ")[0].replace(/\.$/, "").trim();
  return head.charAt(0).toLowerCase() + head.slice(1);
}

async function deliverShowcase(supabase: DB, row: ShowcaseRow): Promise<void> {
  const { data: contact } = await supabase
    .from("wa_contacts")
    .select("id, wa_id, display_name, profile_name")
    .eq("id", row.contact_id)
    .maybeSingle();
  if (!contact) throw new Error("Showcase contact no longer exists.");

  const payload = (row.payload ?? {}) as Partial<ShowcasePayload>;
  const firstName =
    (contact.display_name || contact.profile_name || "").split(/\s+/)[0] || "there";

  // NO links — the message is self-contained (image + text), so the CRM's
  // domain is never exposed. The showcase page stays team-internal.
  const speed = payload.scores?.performance;
  const topIssue = (payload.issues ?? [])[0];
  const punch = [
    speed != null && speed >= 0
      ? `Right now it scores *${speed}/100* on Google's mobile speed test`
      : null,
    topIssue ? shortIssue(topIssue) : null,
  ]
    .filter(Boolean)
    .join(", and ");

  const caption = row.mockup_image_url
    ? `${firstName}, had a quick play with what ${payload.business ?? "your"} site could look like 👆${punch ? `\n\n${punch} — this concept fixes all of that.` : ""}\n\nWant me to walk you through what we'd change?`
    : `${firstName}, took a proper look at your site.${punch ? ` ${punch}.` : ""} Want me to walk you through what we'd fix?`;

  const sent = row.mockup_image_url
    ? await sendWhatsAppImage({
        to: contact.wa_id,
        link: row.mockup_image_url,
        caption,
      })
    : await sendWhatsAppText({ to: contact.wa_id, body: caption });
  if (!sent.ok) throw new Error(sent.error);

  // Internal-only page link for the team's records.
  const pageUrl = appLink(`/showcase/${row.token}`) ?? `/showcase/${row.token}`;

  await supabase.from("wa_messages").insert({
    contact_id: contact.id,
    wa_message_id: sent.waMessageId,
    direction: "out",
    message_type: row.mockup_image_url ? "image" : "text",
    body: caption,
    status: "sent",
    sent_by: "agent",
    meta: row.mockup_image_url
      ? { image_url: row.mockup_image_url, showcase_token: row.token }
      : { showcase_token: row.token },
  });
  await supabase
    .from("wa_contacts")
    .update({
      last_message_at: new Date().toISOString(),
      last_message_preview: caption.slice(0, 160),
      last_direction: "out",
    })
    .eq("id", contact.id);

  if (row.lead_id) {
    await supabase.from("lead_activities").insert({
      lead_id: row.lead_id,
      kind: "automation",
      title: "Showcase delivered",
      body: pageUrl,
      actor_id: null,
    });
  }

  const { data: profiles } = await supabase.from("profiles").select("id");
  for (const p of profiles ?? []) {
    await sendPushToUser({
      userId: p.id,
      title: "Showcase sent 🎨",
      body: `${payload.business ?? "A prospect"} just received their redesign showcase.`,
      link: "/whatsapp",
    });
  }
}
