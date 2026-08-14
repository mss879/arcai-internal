import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import {
  applyOverrides,
  formatPriceField,
  type PricingOverrides,
} from "@/lib/pricing-catalog";

type DB = SupabaseClient<Database>;

/**
 * The WhatsApp agent's built-in knowledge base.
 *
 * Authored once from the actual system so the team never has to write it by
 * hand: the static sections describe the Smart Website system (the product
 * IS this codebase, sold to clients), and the PRICES section is generated
 * fresh on every agent run from PRICING_CATALOG + the /pricing page's saved
 * overrides — edit a price there and the agent quotes the new number on the
 * very next message.
 *
 * Structured for fast retrieval by the model: ALL-CAPS section headers, one
 * fact per bullet, uniform price lines, short Q&A pairs. The team's own
 * `wa_agent_config.knowledge` field is appended AFTER this as TEAM NOTES and
 * overrides anything here.
 */

/** Static product story + facts. Prices live ONLY in the dynamic section. */
const STATIC_KNOWLEDGE = `THE PRODUCT — SMART WEBSITE SYSTEM (what ARC really sells)
- Not "a website" — a system that RUNS a business's sales end-to-end.
- The website captures every inquiry (forms + WhatsApp button) straight into the client's own CRM pipeline board — no inquiry is ever lost or forgotten.
- Quotations are e-signed by the customer right on their phone; invoices are auto-numbered, branded, carry the client's own bank details, and track amount paid vs balance.
- AI sales agents answer customers 24/7 on the website chat, on WhatsApp and on Instagram — in English, Sinhala and Tamil.
- Automatic follow-ups: a lead that goes quiet gets nudged after 2 days, a fresh angle 3 days later — the system never forgets a lead.
- ARC runs this exact system itself. The assistant the prospect is talking to RIGHT NOW is the product.

WHAT THE SYSTEM DOES (feature facts)
- Inquiry capture: website forms, a WhatsApp click-to-chat button and webhooks all land in one pipeline (New Lead → Contacted → Quoted → Won/Lost).
- Signable quotes: the customer opens a link on their phone and signs with a finger; the deposit invoice follows automatically.
- Invoices: auto-numbered, branded PDF, emailed to the customer, bank-account payment details on every invoice, balance tracked until fully paid.
- AI proposals: professional project proposals written by AI from a short description, exported as branded PDFs.
- WhatsApp AI agent (the flagship): answers instantly 24/7, qualifies leads, quotes only from the approved price list, reads photos and bank payment slips, replies to voice notes with voice, keeps promises ("call me Monday" → it messages them Monday), and hands over to a human the moment one is requested.
- Website AI chat: greets visitors, answers from the business's knowledge, captures and qualifies leads, books appointments.
- Instagram: the same AI agent can be connected to Instagram DMs as part of the AI packages.
- Automatic company research: the system researches each new lead's business and briefs the team before anyone picks up the phone.
- Extras built in: client notices, payment reminders, meeting SMS reminders, revenue dashboards and a weekly AI business digest.

E-COMMERCE & STORE AUTOMATIONS (how to sell them)
- The store itself (E-Commerce Store) is the entry point; the REAL product is the Smart Store System — the store plus customer profiles plus workflow automations that run the business's sales on their own.
- What the Smart Store System's automation layer includes as standard: customer profiles built automatically from every order & inquiry, order confirmation + delivery status updates, abandoned-cart recovery, marketing campaigns to their own customer list, and every inquiry captured into their CRM pipeline.
- ANYTHING BEYOND that standard set is an add-on, priced PER AUTOMATION (see PRICES). BRAINSTORM with the customer around THEIR store — ideas to offer: review & feedback requests after delivery, back-in-stock alerts, birthday & loyalty offers, win-back campaigns for lapsed customers, low-stock alerts to the owner, weekly sales report digests, referral nudges, COD-confirmation flows. Ask what eats their time today and propose the automation that removes it.
- A genuinely complex or unusual automation (custom integrations, multi-system flows) → don't guess a price: "let me get the team to confirm that" and notify_team.
- The Smart Store System's exact scope and final number are confirmed on a quick call — the prices in PRICES are honest starting points, never fixed quotes.

PROCESS & TERMS
- Payment: 50% deposit to start, balance on delivery. Work begins the moment the deposit is confirmed.
- Quotations are valid for 7 days.
- Typical delivery: business website packages (Smart Site / Smart Business / Smart System) — exact timeline confirmed with the quote, since every build is scoped to the business · e-commerce store 2–4 weeks (Smart Store System timeline confirmed with its scope) · WhatsApp/Instagram AI agent live in ~5–7 working days.
- Hosting: FREE forever while media stays under 1GB. Domain registration billed to the client at cost.
- Aftercare: Website Protection plans (security, updates, backups, bug fixes) or Pay-Per-Fix per request.

FAQS
Q: How long will my website take?
A: It depends on the package and scope — the exact timeline comes with your quote. E-commerce stores typically run 2–4 weeks; a WhatsApp/Instagram AI agent is live in about a week.
Q: What automations can you add to my store?
A: Customer profiles, order & delivery updates, abandoned-cart recovery, marketing campaigns and CRM capture come standard with the Smart Store System. Beyond that, almost anything repetitive can be automated as a per-automation add-on — review requests, restock alerts, loyalty offers, win-back campaigns and more (brainstorm with them; prices in PRICES).
Q: What do you need from me to start?
A: Your logo, any photos you have, and a short chat about what the business does. Our AI drafts the content — you approve it.
Q: Do I own the website?
A: Yes — the site and its content are yours. Hosting is free under 1GB, and your domain is registered in your name.
Q: I already have a website — can you improve it?
A: Yes. We run a free audit (speed, SEO, design) and show you a redesign concept of your own site before you commit.
Q: Which languages do the AI agents speak?
A: English, Sinhala and Tamil — they automatically match the customer's language.
Q: How do payments from my customers reach me?
A: Invoices carry YOUR bank details — customers pay you directly and the system tracks what's paid and what's due.
Q: Can I see the system working before I buy?
A: You already are — this assistant is the same AI agent your customers would get on your website and WhatsApp.`;

/** 60-second single-flight memo. A drain of several concurrent agent runs
 * renders the knowledge base ONCE instead of once per run; the promise (not
 * the string) is cached so concurrent callers share the in-flight render.
 * Staleness bound: price edits and newly approved FAQ lessons reach the
 * agent within ≤60s on other instances (the invalidation hook below clears
 * the same-instance memo instantly). */
let knowledgeMemo: { at: number; promise: Promise<string> } | null = null;
const KNOWLEDGE_MEMO_TTL_MS = 60_000;

/** Called after a pricing save so the editing instance re-renders at once. */
export function invalidateAgentKnowledge(): void {
  knowledgeMemo = null;
}

/**
 * Build the full knowledge base: static story + live PRICES from the
 * pricing catalog with the team's saved overrides layered on. Never throws —
 * a failed overrides read just falls back to catalog defaults.
 */
export async function buildAgentKnowledge(supabase: DB): Promise<string> {
  if (knowledgeMemo && Date.now() - knowledgeMemo.at < KNOWLEDGE_MEMO_TTL_MS)
    return knowledgeMemo.promise;
  const promise = renderAgentKnowledge(supabase);
  knowledgeMemo = { at: Date.now(), promise };
  return promise;
}

async function renderAgentKnowledge(supabase: DB): Promise<string> {
  // Both reads are independent — fetch concurrently, degrade independently
  // (allSettled preserves the old per-query error isolation).
  const [pricingRes, faqRes] = await Promise.allSettled([
    supabase.from("pricing_config").select("overrides").eq("id", 1).maybeSingle(),
    supabase
      .from("wa_lessons")
      .select("body")
      .eq("status", "approved")
      .eq("kind", "faq")
      .order("decided_at", { ascending: false })
      .limit(12),
  ]);
  const overrides: PricingOverrides =
    pricingRes.status === "fulfilled"
      ? ((pricingRes.value.data?.overrides ?? {}) as PricingOverrides)
      : {};

  const groups = applyOverrides(overrides);
  const priceLines: string[] = ["PRICES (current — quote these exactly)"];
  for (const group of groups) {
    priceLines.push(
      `${group.title.toUpperCase()}${group.subtitle ? ` — ${group.subtitle}` : ""}`,
    );
    for (const pkg of group.packages) {
      const label = [
        pkg.name,
        pkg.badge ? `(${pkg.badge})` : null,
        pkg.tagline ? `— ${pkg.tagline}` : null,
      ]
        .filter(Boolean)
        .join(" ");
      const prices = pkg.prices
        .map((f) =>
          f.label && f.label !== "Price"
            ? `${f.label}: ${formatPriceField(f)}`
            : formatPriceField(f),
        )
        .join(" · ");
      const features = (pkg.features ?? []).slice(0, 3).join(", ");
      priceLines.push(
        `- ${label}${prices ? ` — ${prices}` : ""}${features ? `. ${features}` : ""}${pkg.note ? ` (${pkg.note})` : ""}`,
      );
    }
  }

  // FAQ gaps the nightly miner spotted in real chats ("let me get the team
  // to confirm that" moments), answered and APPROVED by the team in the
  // Lessons queue. A missing table (migration 0073 not yet applied) just
  // leaves the section out — the query errors softly and faqs stays empty.
  let learnedFaqs = "";
  const faqs = faqRes.status === "fulfilled" ? faqRes.value.data ?? [] : [];
  if (faqs.length) {
    learnedFaqs = `\n\nTEAM-CONFIRMED FAQS (learned from real conversations — answer from these with confidence)\n${faqs
      .map((f) => f.body.trim())
      .join("\n")}`;
  }

  return `${STATIC_KNOWLEDGE}\n\n${priceLines.join("\n")}${learnedFaqs}`;
}
