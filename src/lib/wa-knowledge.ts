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

PROCESS & TERMS
- Payment: 50% deposit to start, balance on delivery. Work begins the moment the deposit is confirmed.
- Quotations are valid for 7 days.
- Typical delivery: Starter site 2–3 days · Launch 3–5 days · Growth/Scale 5–7 days · Shopify store 5–7 days · custom store 2–4 weeks · WhatsApp AI agent live in ~5–7 working days.
- Hosting: FREE forever while media stays under 1GB. Domain registration billed to the client at cost.
- Aftercare: Website Protection plans (security, updates, backups, bug fixes) or Pay-Per-Fix per request.

FAQS
Q: How long will my website take?
A: Starter 2–3 days, Launch 3–5, Growth/Scale 5–7. E-commerce and AI agents take longer — see delivery times above.
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

/**
 * Build the full knowledge base: static story + live PRICES from the
 * pricing catalog with the team's saved overrides layered on. Never throws —
 * a failed overrides read just falls back to catalog defaults.
 */
export async function buildAgentKnowledge(supabase: DB): Promise<string> {
  let overrides: PricingOverrides = {};
  try {
    const { data } = await supabase
      .from("pricing_config")
      .select("overrides")
      .eq("id", 1)
      .maybeSingle();
    overrides = (data?.overrides ?? {}) as PricingOverrides;
  } catch {
    // Catalog defaults are always available.
  }

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

  return `${STATIC_KNOWLEDGE}\n\n${priceLines.join("\n")}`;
}
