/**
 * Proposal catalog + pricing.
 *
 * This is the SINGLE SOURCE OF TRUTH for everything a proposal can cost.
 * The generator form, the live preview and the server-side PDF all import
 * `buildPricing()` from here so the numbers are identical everywhere — and
 * the AI text generator is never allowed to invent a price.
 *
 * Figures come from the ARC AI pricing catalog (LKR, one-time unless noted).
 *
 * TWO SHAPES LIVE HERE, and which one a proposal uses is decided by PRESENCE:
 *   - LEGACY: one package (`type` + `tier`/`platform`/`agentPlatform`) priced
 *     off the constants below. Every proposal saved before multi-item support
 *     is this shape and must keep re-pricing byte-identically forever.
 *   - ITEM-DRIVEN: `selection.items` — any number of priced lines, drawn from
 *     the /pricing catalog or written bespoke, with mixed recurrence. This is
 *     what lets ONE proposal quote a website AND a monthly social retainer.
 * A selection with no `items` key takes the legacy path, character for
 * character. Nothing is ever backfilled onto a stored row.
 */

import type {
  PriceField,
  PricingGroup,
  PricingPackage,
} from "@/lib/pricing-catalog";

// ---- Company / sign-off (printed on the proposal) ------------------------

export const PROPOSAL_COMPANY = {
  name: "ARC AI AGENCY (PVT) LTD",
  phones: "+44 7466 368427 (UK), +94 771852522 (LK)",
  email: "support@arcai.agency",
  website: "www.arcai.agency",
  addressLines: ["Colombo 4, Sri Lanka", "Birmingham, UK"],
};

export const PROPOSAL_SIGNOFF = {
  preparedBy: "Shahid Shamir",
  email: "support@arcai.agency",
};

// ---- Selection -----------------------------------------------------------

export type ProjectType = "business" | "ecommerce" | "agent";
/** "whatsapp" / "instagram" are the standalone channel agents.
 * "smart_system_budget" rides the agent machinery too: the budget Smart
 * System (streamlined WhatsApp agent + CRM + ONE automation, no website) —
 * an agent-class product, so it quotes and proposes with no page counts. */
export type AgentPlatform = "whatsapp" | "instagram" | "smart_system_budget";
/** "smart_site" / "smart_business" / "smart_system" are the current lineup
 * (2026-08 repricing). "starter"–"scale" are LEGACY: old stored proposals
 * carry them and re-price on every render, so they must keep their original
 * numbers forever. Never offered on anything new. */
export type BusinessTierKey =
  | "smart_site"
  | "smart_business"
  | "smart_system"
  | "starter"
  | "launch"
  | "growth"
  | "scale";
/** "store" and "smart" are the current lineup (2026-08 repricing). "shopify"
 * and "custom" are LEGACY: proposals saved before the repricing carry them in
 * their stored selection, and buildPricing re-runs on every render — so the
 * old plans must keep producing their original names and numbers forever.
 * Never offer them on anything new. */
export type EcommercePlatform = "store" | "smart" | "shopify" | "custom";
export type MaintenanceKey = "none" | "m3" | "m6" | "m12";

// ---- Multi-item proposals (additive; a selection without `items` is untouched) ----

/**
 * How often a line is charged. This is the ONLY thing that decides which total
 * a line lands in — a monthly social retainer must never be summed into the
 * one-time build cost, which is precisely why a proposal could not carry one
 * before.
 */
export type LineRecurrence = "one_time" | "monthly" | "yearly" | "at_cost";

/**
 * One priced thing the client is buying. A proposal may carry any number of
 * these, drawn from the /pricing catalog or written bespoke — this is what
 * lets a single proposal quote a website AND a social-media retainer.
 */
export type ProposalLineItem = {
  /** Stable within one proposal; how update_proposal targets a line for edit
   * or removal. Use the catalog key when there is one, else a slug of `label`. */
  id: string;
  /** PriceField.key from PRICING_CATALOG, e.g. "smm.intermediate.monthly".
   * null for a bespoke line the team wrote by hand. Never invented. */
  catalogKey: string | null;
  /** PricingPackage.key the line came from, e.g. "smm_intermediate". Kept so a
   * future reader can find the package again even if a price key is retired. */
  packageKey?: string | null;
  /** Prints in the Investment table's DESCRIPTION cell. */
  label: string;
  /** Short qualifier appended in brackets, e.g. "agreed rate", "12 months". */
  note?: string;
  /**
   * The package's feature bullets, COPIED IN at write time — never looked up
   * live. This is what makes the proposal print what the client is actually
   * buying, and it must stay frozen for the same reason `prices` is frozen:
   * the catalog will change, the sent proposal must not.
   */
  features: string[];
  /** Hide the copied features on this one line without deleting them.
   * Absent = show them whenever `features` is non-empty. */
  showFeatures?: boolean;
  /** What the client pays, per unit, in LKR. Exactly the figure the team
   * stated — never rounded, never reconciled against the catalog. */
  amount: number;
  /** The list price this came down from. Rendered struck through, and ONLY
   * when it is strictly greater than `amount` (same rule as the legacy
   * `prices.baseList`). Absent = single plain price. */
  listAmount?: number;
  /** Default 1. Multiplies `amount` for the printed line total. */
  quantity?: number;
  recurrence: LineRecurrence;
  /** Print " (starts at)" after the label — mirrors PriceField.prefix === "from".
   * The writer MUST clear this whenever the team dictated an exact amount, the
   * same rule buildPricing already applies to the legacy base line. */
  startsAt?: boolean;
};

export type ProposalSelection = {
  type: ProjectType;
  tier: BusinessTierKey; // used when type === "business"
  platform: EcommercePlatform; // used when type === "ecommerce"
  /** Used when type === "agent". Selections stored before this field existed
   * lack it — every read must fall back to "whatsapp". */
  agentPlatform?: AgentPlatform;
  paymentGateway: boolean; // custom e-commerce add-on
  delivery: boolean; // custom e-commerce add-on
  maintenance: MaintenanceKey;
  monthlySeo: boolean;
  customFeatures: { name: string; price: number }[];
  /**
   * Prices FROZEN into this proposal the moment it was created — resolved from
   * the /pricing page's saved amounts, or dictated by the team for this one
   * client. Absent on every proposal saved before this field existed, and those
   * therefore keep re-pricing from the catalog constants below exactly as they
   * always have. Never backfill it onto an old row: a sent proposal must keep
   * printing the numbers the client agreed to.
   */
  prices?: {
    base?: number;
    /** The package's LIST price at the time. Kept alongside `base` so a
     * negotiated price prints as "~~Rs 175,000~~ Rs 140,000" — the client sees
     * exactly what they were given off. Equal to `base` when nothing was
     * discounted, which prints as a plain single price. */
    baseList?: number;
    maintenance?: number;
    monthlySeo?: number;
  };
  /** Short note appended to the main line's label, e.g. "agreed rate". */
  baseNote?: string;
  /**
   * Any number of priced lines. PRESENT = this proposal is item-driven: the
   * legacy single-package block (type/tier/platform/agentPlatform + prices.base
   * + baseList + baseNote) is IGNORED for pricing entirely. ABSENT = every
   * existing code path runs exactly as it does today. Never backfilled onto a
   * stored row — a sent proposal keeps printing the numbers the client agreed to.
   */
  items?: ProposalLineItem[];
  /**
   * Extra notes printed under the totals (the at-cost / monthly-fee sentences).
   * With `items` present the package's own `monthlyNote` is gone, so this is
   * where "AI usage billed at cost — no monthly fee to ARC" is carried.
   */
  notes?: string[];
};

export function defaultSelection(): ProposalSelection {
  return {
    type: "business",
    tier: "smart_business",
    platform: "store",
    agentPlatform: "whatsapp",
    paymentGateway: false,
    delivery: false,
    maintenance: "none",
    monthlySeo: false,
    customFeatures: [],
  };
}

// ---- Catalog -------------------------------------------------------------
export type BusinessTier = {
  key: BusinessTierKey;
  name: string;
  tagline: string;
  price: number;
  /** True when the price is a floor ("from Rs X"), not a fixed figure. */
  startsAt?: boolean;
  pages: number;
  additionalPageRate: number;
  hasCRM: boolean;
  hasAI: boolean;
  monthlyNote?: string;
  features: string[];
};

export const BUSINESS_TIERS: Record<BusinessTierKey, BusinessTier> = {
  smart_site: {
    key: "smart_site",
    name: "Smart Site",
    tagline: "Website + CRM + AI Answers",
    price: 175000,
    pages: 15,
    additionalPageRate: 6000,
    hasCRM: true,
    hasAI: true,
    monthlyNote: "AI usage billed at cost — no monthly fee to ARC",
    features: [
      "Premium responsive website (15 pages)",
      "Backend CRM — every inquiry lands in one pipeline",
      "AI agent answering customer questions 24/7",
      "Customer-service agent: answers & guides (no action steps)",
      "Full SEO with structured data & meta tags",
      "Free hosting forever (under 1GB)",
    ],
  },
  smart_business: {
    key: "smart_business",
    name: "Smart Business",
    tagline: "The Agent That Does The Work",
    price: 250000,
    pages: 25,
    additionalPageRate: 6000,
    hasCRM: true,
    hasAI: true,
    monthlyNote: "AI usage billed at cost — no monthly fee to ARC",
    features: [
      "Everything in Smart Site (25 pages)",
      "Advanced CRM — lead scoring + multi-level user access",
      "AI agent that TAKES ACTION: creates invoices, writes proposals, emails customers",
      "Conversion-optimized design with strategic CTAs",
    ],
  },
  smart_system: {
    key: "smart_system",
    name: "Smart System",
    tagline: "One Smart System. Every Next Step.",
    price: 450000,
    startsAt: true,
    pages: 50,
    additionalPageRate: 6000,
    hasCRM: true,
    hasAI: true,
    monthlyNote: "AI usage billed at cost — no monthly fee to ARC",
    features: [
      "Everything in Smart Business — unlimited pages (fair use up to 50) + very advanced SEO",
      "AI agent on WhatsApp AND Instagram — follows up your CRM leads automatically",
      "3 custom workflow automations of your choice included",
      "Reminders & a far more interactive agent",
    ],
  },
  // -- LEGACY tiers below: old stored proposals re-render through
  //    buildPricing, so these must keep their original numbers. Never
  //    offered on new proposals or quotes.
  starter: {
    key: "starter",
    name: "Starter",
    tagline: "Get Online Fast",
    price: 60000,
    pages: 5,
    additionalPageRate: 4000,
    hasCRM: false,
    hasAI: false,
    features: [
      "Modern responsive website (5 pages)",
      "Clean, minimal design — standard layouts",
      "WhatsApp button + contact / inquiry form",
      "Mobile-optimized & fast-loading",
      "Free hosting forever",
    ],
  },
  launch: {
    key: "launch",
    name: "Launch",
    tagline: "Stand Out & Convert",
    price: 90000,
    pages: 8,
    additionalPageRate: 6000,
    hasCRM: false,
    hasAI: false,
    features: [
      "Modern responsive website (8 pages)",
      "Premium custom design with advanced animations",
      "Parallax scrolling, hover effects, micro-interactions",
      "Glassmorphism cards & bespoke hero section",
      "Conversion-optimized layout with strategic CTAs",
      "Full SEO with structured data & meta tags",
    ],
  },
  growth: {
    key: "growth",
    name: "Growth",
    tagline: "Capture & Close Leads",
    price: 130000,
    pages: 15,
    additionalPageRate: 6000,
    hasCRM: true,
    hasAI: false,
    features: [
      "Extensive responsive website (15 pages)",
      "Everything in Launch",
      "Lead Dashboard — every inquiry in one place",
      "CRM pipeline (New → Contacted → Quoted → Won/Lost)",
      "Email capture + newsletter system",
      "Email campaigns — promos, updates, re-engagement",
    ],
  },
  scale: {
    key: "scale",
    name: "Scale",
    tagline: "24/7 AI-Powered Sales",
    price: 160000,
    pages: 23,
    additionalPageRate: 6000,
    hasCRM: true,
    hasAI: true,
    monthlyNote: "+ $4/month AI fee",
    features: [
      "Extensive responsive website (23 pages)",
      "Everything in Growth",
      "AI agent integrated into your website",
      "Instant responses to visitor questions 24/7",
      "Handles common inquiries & guides users to action",
      "1 month free keyword optimization",
    ],
  },
};

export type EcommercePlan = {
  key: EcommercePlatform;
  name: string;
  price: number;
  startsAt: boolean;
  monthlyNote: string;
  features: string[];
};

export const ECOMMERCE: Record<EcommercePlatform, EcommercePlan> & {
  addons: { paymentGateway: number; delivery: number; automation: number };
} = {
  store: {
    key: "store",
    name: "E-Commerce Store",
    price: 150000,
    startsAt: true,
    monthlyNote: "Includes 500MB free backend; then $25/month if storage exceeds 500MB",
    features: [
      "100% custom-coded online store (Next.js) — no theme templates",
      "Product catalog, cart & secure checkout",
      "Payment gateway & delivery integration included",
      "Mobile-first, fast-loading, full technical SEO",
      "Free hosting forever (under 1GB media)",
    ],
  },
  smart: {
    key: "smart",
    name: "Smart Store System",
    price: 350000,
    startsAt: true,
    monthlyNote:
      "Includes 500MB free backend; then $25/month if storage exceeds 500MB. Variable AI usage billed at cost.",
    features: [
      "Everything in E-Commerce Store",
      "Customer profiles built automatically from every order & inquiry",
      "Order confirmation & delivery updates sent automatically",
      "Abandoned-cart recovery messages",
      "Marketing campaigns to your own customer list",
      "Every inquiry lands in your CRM pipeline — nothing lost",
    ],
  },
  // -- LEGACY plans below: old stored proposals re-render through
  //    buildPricing, so these must keep their original numbers. Never
  //    offered on new proposals or quotes.
  shopify: {
    key: "shopify",
    name: "Shopify Theme Build",
    price: 75000,
    startsAt: false,
    monthlyNote: "+ $25/month, paid directly to Shopify",
    features: [
      "Built using the official Shopify store builder",
      "High-quality, reliable theme-based design",
      "Standard e-commerce layout & user flows",
      "Easy-to-use product management dashboard",
      "Built-in secure checkout process",
    ],
  },
  custom: {
    key: "custom",
    name: "Custom Next.js Store",
    price: 120000,
    startsAt: true,
    monthlyNote: "Includes 500MB free backend; then $25/month if storage exceeds 500MB",
    features: [
      "100% custom-coded storefront using Next.js & React",
      "Amazing, premium design with bespoke animations",
      "Advanced UI features like glassmorphism & parallax",
      "Unmatched loading speed & performance",
      "Deeper, unrestricted technical SEO capabilities",
      "Ultimate flexibility: add any custom feature you want",
    ],
  },
  addons: { paymentGateway: 25000, delivery: 25000, automation: 30000 },
};

/** Standalone AI agent + CRM packages (2026-08) — kept in lockstep with the
 * pricing catalog's "AI & Automation" group. */
export const AGENT_PLANS: Record<
  AgentPlatform,
  { key: AgentPlatform; name: string; price: number; monthlyNote: string; features: string[] }
> = {
  whatsapp: {
    key: "whatsapp",
    name: "WhatsApp AI Agent + CRM",
    price: 175000,
    monthlyNote:
      "No monthly fee to ARC — the client pays only their own AI/API usage, at cost",
    features: [
      "Autonomous AI rep on your own WhatsApp number",
      "Answers, qualifies, follows up & books 24/7 — English, Sinhala & Tamil",
      "Full CRM included — every chat becomes a tracked lead",
      "Reads photos & payment slips; voice-note replies",
      "Automatic follow-ups so no lead is forgotten",
    ],
  },
  instagram: {
    key: "instagram",
    name: "Instagram AI Agent + CRM",
    price: 150000,
    monthlyNote:
      "No monthly fee to ARC — the client pays only their own AI/API usage, at cost",
    features: [
      "Autonomous AI rep in your Instagram DMs",
      "Answers, qualifies, follows up & books 24/7 — English, Sinhala & Tamil",
      "Full CRM included — every chat becomes a tracked lead",
      "Automatic follow-ups so no lead is forgotten",
    ],
  },
  smart_system_budget: {
    key: "smart_system_budget",
    name: "Smart System Budget",
    price: 150000,
    monthlyNote:
      "No monthly fee to ARC — the client pays only their own AI/API usage, at cost",
    features: [
      "AI agent on your own WhatsApp number — answers & sells 24/7 (English, Sinhala & Tamil)",
      "Streamlined agent — no automatic data gathering or analytics",
      "Smart CRM — every chat becomes a tracked lead in one pipeline",
      "1 custom workflow automation of your choice",
      "No website — upgrading later credits what you've paid toward the full Smart System",
    ],
  },
};

/** Sensible default timeline for an agent-only proposal — the website
 * timeline talks about pages and design, which reads wrong for an agent
 * deployment. Fully editable in the form, like everything else. */
export const AGENT_TIMELINE: TimelineStep[] = [
  { title: "Kickoff & Access", description: "Connect the WhatsApp/Instagram account, collect business knowledge, confirm the sales flow", duration: "Day 1-2" },
  { title: "Build & Training", description: "Agent configured on your number, CRM pipeline set up, knowledge base loaded and tuned", duration: "Day 3-5" },
  { title: "Test, Launch & Handover", description: "Live test conversations, tone adjustments, go-live and team walkthrough", duration: "Day 6-7" },
];

export const MAINTENANCE: Record<
  Exclude<MaintenanceKey, "none">,
  { key: MaintenanceKey; name: string; months: number; price: number }
> = {
  m3: { key: "m3", name: "Website Protection — 3 Months", months: 3, price: 40000 },
  m6: { key: "m6", name: "Website Protection — 6 Months", months: 6, price: 60000 },
  m12: { key: "m12", name: "Website Protection — 12 Months", months: 12, price: 90000 },
};

export const MONTHLY_SEO = 20000;
export const PAY_PER_FIX = 5000;

// ---- Pricing -------------------------------------------------------------

export type PriceLine = {
  label: string;
  amount: number;
  /** List price, when `amount` is a discounted offer. Rendered struck through
   * next to the amount so the client sees the reduction. */
  original?: number;
  /** Absent = "one_time". Legacy proposals never set it, so nothing changes. */
  recurrence?: LineRecurrence;
  /** Feature bullets to print under the label, small and muted. Absent = none. */
  features?: string[];
};
export type Pricing = {
  lineItems: PriceLine[];
  /** Sum of the ONE-TIME lines only. Identical to today for any legacy row,
   * because a legacy row can only produce one-time lines. This is what goes
   * into `proposals.grand_total` — Finance reads it as money-now. */
  oneTimeTotal: number;
  recurringNotes: string[];
  /** Absent or 0 when nothing recurs — the PDF prints no extra total row. */
  monthlyTotal?: number;
  yearlyTotal?: number;
};

/**
 * True only when this proposal was WRITTEN item-driven. A legacy row has no
 * `items` key at all, so it can never take the new path by accident — which is
 * what keeps every already-sent proposal re-pricing exactly as it always has.
 */
export function hasItems(
  sel: ProposalSelection,
): sel is ProposalSelection & { items: ProposalLineItem[] } {
  return Array.isArray(sel.items) && sel.items.length > 0;
}

/** How many of a line are being bought. Guarded because items arrive as JSON. */
function qty(item: ProposalLineItem): number {
  const q = Number(item.quantity);
  return Number.isFinite(q) && q > 0 ? q : 1;
}

/**
 * A line's recurrence, coerced to one of the four known values. Items arrive as
 * JSON that nothing validates on the way in, and an unrecognised string must
 * not fall between the totals and the printed suffix — `recurrenceSuffix()`
 * would call it one-time while `buildPricing` summed it into nothing, so the
 * table would silently stop adding up. Anything unknown is one-time.
 */
function recurrenceOf(item: ProposalLineItem): LineRecurrence {
  switch (item.recurrence) {
    case "monthly":
    case "yearly":
    case "at_cost":
      return item.recurrence;
    default:
      return "one_time";
  }
}

/** A line's printed amount. `at_cost` is deliberately zero: it must never move
 * a total, and the PDF prints the words "At cost" in the amount cell instead. */
function lineAmount(item: ProposalLineItem): number {
  if (recurrenceOf(item) === "at_cost") return 0;
  const a = Number(item.amount);
  return (Number.isFinite(a) ? a : 0) * qty(item);
}

/**
 * A line's feature bullets as a clean string array. `features` is stored JSON,
 * so it can be null, a bare string, or hold blanks — and every one of those
 * reaches the PDF, where `.map()` on a non-array throws and takes the whole
 * document down with it. Nothing downstream should have to defend itself.
 */
function featuresOf(item: ProposalLineItem): string[] {
  if (!Array.isArray(item.features)) return [];
  const out: string[] = [];
  for (const f of item.features) {
    if (typeof f === "string" && f.trim()) out.push(f.trim());
  }
  return out;
}

/** Drop anything malformed before it can reach the renderer: one bad entry in
 * a stored JSON blob must not make a sent proposal unopenable. */
function validItems(sel: ProposalSelection): ProposalLineItem[] {
  if (!hasItems(sel)) return [];
  return sel.items.filter(
    (i): i is ProposalLineItem =>
      Boolean(i) && typeof i === "object" && typeof i.label === "string" && i.label.trim() !== "",
  );
}

/**
 * The package's list price straight from the catalog, ignoring anything frozen
 * onto the proposal. Used to record what a negotiated price was discounted
 * FROM, so the proposal can show both figures.
 *
 * Item-driven: the sum of what the ONE-TIME lines would normally have cost.
 * That value is inert for pricing (an item-driven proposal never reads
 * `prices.base`), but it must still be a sane number rather than a stale
 * single-package price in case a reader shows "normally Rs X".
 */
export function catalogBasePrice(sel: ProposalSelection): number {
  if (hasItems(sel)) {
    return validItems(sel)
      .filter((i) => recurrenceOf(i) === "one_time")
      .reduce((s, i) => {
        const list = Number(i.listAmount);
        const base = Number.isFinite(list) ? list : Number(i.amount);
        return s + (Number.isFinite(base) ? base : 0) * qty(i);
      }, 0);
  }
  if (sel.type === "business") return BUSINESS_TIERS[sel.tier].price;
  if (sel.type === "agent") return AGENT_PLANS[sel.agentPlatform ?? "whatsapp"].price;
  return (ECOMMERCE[sel.platform] ?? ECOMMERCE.store).price;
}

/** A usable frozen price, or null so the catalog default takes over. */
function num(v: number | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Deterministically turn a selection into priced line items + recurring notes. */
export function buildPricing(sel: ProposalSelection): Pricing {
  const lineItems: PriceLine[] = [];
  const recurringNotes: string[] = [];

  // A price frozen into THIS proposal beats the catalog default. Once an exact
  // figure has been agreed the package is no longer a "starts at" floor, so
  // that suffix comes off.
  const baseOverride = num(sel.prices?.base);
  const note = sel.baseNote?.trim();
  const mainLabel = (name: string, startsAt: boolean) =>
    `${name}${startsAt && baseOverride === null ? " (starts at)" : ""}${
      note ? ` (${note})` : ""
    }`;
  // What the package normally goes for. Only shown when the client is actually
  // being charged less than that — never as a fake "was" price.
  const listed = num(sel.prices?.baseList);
  const struck = (charged: number) =>
    listed !== null && listed > charged ? listed : undefined;

  if (hasItems(sel)) {
    // ITEM-DRIVEN. The legacy package block below is skipped ENTIRELY — and
    // with it `prices.base`, `prices.baseList`, `baseNote`, `paymentGateway`
    // and `delivery`, which all describe a single package line that no longer
    // exists here. Reading a stale frozen `base` alongside the items would
    // print a phantom line and double-count the build.
    for (const item of validItems(sel)) {
      const recurrence = recurrenceOf(item);
      const label = `${item.label.trim()}${item.startsAt ? " (starts at)" : ""}${
        item.note?.trim() ? ` (${item.note.trim()})` : ""
      }`;
      const amount = lineAmount(item);
      // Same rule as the legacy `struck()`: only ever shown when the client is
      // genuinely being charged less than the list price.
      //
      // `listAmount` is PER UNIT, exactly like `amount` — the builder's "Was"
      // field sits beside "Price (LKR)", and `catalogBasePrice` multiplies it
      // out the same way. So it has to be multiplied by the quantity before it
      // can be compared with, or printed beside, a line TOTAL. Comparing a
      // per-unit list price against a multiplied amount silently dropped the
      // strike-through the moment a line carried a quantity above one: two
      // reels at Rs 25,000 discounted to Rs 20,000 each printed Rs 40,000 with
      // no reduction shown at all.
      const list = Number(item.listAmount);
      const listTotal = Number.isFinite(list) ? list * qty(item) : Number.NaN;
      const original =
        Number.isFinite(listTotal) && listTotal > amount && recurrence !== "at_cost"
          ? listTotal
          : undefined;
      lineItems.push({
        label,
        amount,
        original,
        recurrence,
        features: item.showFeatures === false ? undefined : featuresOf(item),
      });
      // At-cost work is charged through with no ARC margin, so it carries no
      // figure at all — it belongs in the notes, not in any total.
      if (recurrence === "at_cost") recurringNotes.push(`${label} — at cost`);
    }
  } else if (sel.type === "business") {
    const t = BUSINESS_TIERS[sel.tier];
    const amount = baseOverride ?? t.price;
    lineItems.push({
      label: mainLabel(`${t.name} Website — ${t.pages} pages`, Boolean(t.startsAt)),
      amount,
      original: struck(amount),
    });
    if (t.monthlyNote) recurringNotes.push(t.monthlyNote);
  } else if (sel.type === "agent") {
    const plan = AGENT_PLANS[sel.agentPlatform ?? "whatsapp"];
    const amount = baseOverride ?? plan.price;
    lineItems.push({
      label: mainLabel(`${plan.name} — setup`, false),
      amount,
      original: struck(amount),
    });
    recurringNotes.push(plan.monthlyNote);
  } else {
    // A selection saved before the 2026-08 repricing can carry a legacy
    // platform — it must keep pricing exactly as it did the day it was sent.
    const plan = ECOMMERCE[sel.platform] ?? ECOMMERCE.store;
    const amount = baseOverride ?? plan.price;
    lineItems.push({
      label: mainLabel(plan.name, plan.startsAt),
      amount,
      original: struck(amount),
    });
    recurringNotes.push(plan.monthlyNote);
    // Gateway & delivery were separate add-ons only on the legacy custom
    // plan — the current store packages include both.
    if (sel.platform === "custom") {
      if (sel.paymentGateway) {
        lineItems.push({
          label: "Payment Gateway Integration",
          amount: ECOMMERCE.addons.paymentGateway,
        });
      }
      if (sel.delivery) {
        lineItems.push({
          label: "Delivery Integration",
          amount: ECOMMERCE.addons.delivery,
        });
      }
    }
  }

  if (sel.maintenance !== "none") {
    const m = MAINTENANCE[sel.maintenance];
    lineItems.push({
      label: m.name,
      amount: num(sel.prices?.maintenance) ?? m.price,
    });
  }

  if (sel.monthlySeo) {
    const seo = num(sel.prices?.monthlySeo) ?? MONTHLY_SEO;
    recurringNotes.push(`Monthly SEO — ${money(seo)}/month`);
  }

  // Add custom features to pricing
  if (sel.customFeatures && sel.customFeatures.length > 0) {
    for (const f of sel.customFeatures) {
      if (f.name.trim()) {
        lineItems.push({
          label: f.name.trim(),
          amount: Number(f.price) || 0,
        });
      }
    }
  }

  // Free-text notes that belong to the proposal as a whole ("no monthly fee to
  // ARC…"), printed under the totals. Only item-driven proposals carry them —
  // a legacy one gets its note from the package's own `monthlyNote`.
  if (hasItems(sel) && Array.isArray(sel.notes)) {
    for (const n of sel.notes) {
      if (typeof n === "string" && n.trim()) recurringNotes.push(n.trim());
    }
  }

  // A line with no `recurrence` is one-time — which is every line a legacy
  // selection can produce, so this reduce is identical to the old
  // `lineItems.reduce((s, l) => s + l.amount, 0)` for them.
  const sumOf = (r: LineRecurrence) =>
    lineItems.reduce((s, l) => s + ((l.recurrence ?? "one_time") === r ? l.amount : 0), 0);
  const oneTimeTotal = sumOf("one_time");

  // Legacy proposals return the exact same three-key object they always have.
  if (!hasItems(sel)) return { lineItems, oneTimeTotal, recurringNotes };

  return {
    lineItems,
    oneTimeTotal,
    recurringNotes,
    monthlyTotal: sumOf("monthly"),
    yearlyTotal: sumOf("yearly"),
  };
}

/** The labels a summary/name is built from: real packages, not pass-through
 * costs. An "AI usage" at-cost line is not something the proposal is FOR. */
function summaryLabels(sel: ProposalSelection): string[] {
  return validItems(sel)
    .filter((i) => recurrenceOf(i) !== "at_cost")
    .map((i) => i.label.trim())
    .filter(Boolean);
}

/** Short human label for the selected package, e.g. for the cover + AI prompt. */
export function selectionSummary(sel: ProposalSelection): string {
  // Item-driven: name everything being sold, e.g.
  // "Smart Business Website + Halo Media — Intermediate". Falls through to the
  // legacy summary if the items yield no usable label, so a caller is never
  // handed an empty string.
  const labels = summaryLabels(sel);
  if (labels.length > 0) {
    const shown = labels.slice(0, 4).join(" + ");
    const rest = labels.length - 4;
    return rest > 0 ? `${shown} + ${rest} more` : shown;
  }

  if (sel.type === "business") {
    const t = BUSINESS_TIERS[sel.tier];
    const scope = t.hasAI
      ? "Frontend + Backend CRM + AI Agent"
      : t.hasCRM
        ? "Frontend + Backend CRM"
        : "Frontend Website";
    return `${t.name} — ${scope}`;
  }
  if (sel.type === "agent") {
    const plan = AGENT_PLANS[sel.agentPlatform ?? "whatsapp"];
    return `AI Agent — ${plan.name} (no website build; agent + CRM deployment)`;
  }
  if (sel.platform === "smart")
    return "E-Commerce — Smart Store System (store + customer profiles + automations)";
  if (sel.platform === "shopify") return "E-Commerce — Shopify Store";
  if (sel.platform === "custom") {
    const extras = [
      sel.paymentGateway && "Payment Gateway",
      sel.delivery && "Delivery",
    ]
      .filter(Boolean)
      .join(" + ");
    return `E-Commerce — Custom Next.js Store${extras ? ` + ${extras}` : ""}`;
  }
  return "E-Commerce — Custom Online Store";
}

/** Short project name suggestion for the cover (e.g. "Website + AI Agent"). */
export function suggestedProjectName(sel: ProposalSelection): string {
  const labels = summaryLabels(sel);
  if (labels.length > 0) return labels.slice(0, 2).join(" + ");
  if (sel.type === "agent") return AGENT_PLANS[sel.agentPlatform ?? "whatsapp"].name;
  if (sel.type === "ecommerce")
    return sel.platform === "smart" ? "Smart Store System" : "E-Commerce Store";
  const t = BUSINESS_TIERS[sel.tier];
  if (t.hasAI) return "Website + AI Agent";
  if (t.hasCRM) return "Website + Backend CRM";
  return "Business Website";
}

/** Feature bullets of the selected package — handed to the AI as grounding. */
export function includedFeatures(sel: ProposalSelection): string[] {
  // Item-driven: the features of EVERY package on the proposal, flattened and
  // de-duplicated. This is what makes "get the pricing, then include all of
  // those features" structural rather than a thing the prompt has to beg for.
  // Prefer `proposalPackages()` where the caller can group them per package.
  if (hasItems(sel)) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of validItems(sel)) {
      for (const t of featuresOf(item)) {
        const k = t.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(t);
      }
    }
    // Every item bespoke and featureless — fall through so the writer is never
    // handed nothing to work with.
    if (out.length > 0) return out;
  }
  if (sel.type === "business") return BUSINESS_TIERS[sel.tier].features;
  if (sel.type === "agent")
    return AGENT_PLANS[sel.agentPlatform ?? "whatsapp"].features;
  return (ECOMMERCE[sel.platform] ?? ECOMMERCE.store).features;
}

/**
 * Every package on the proposal with its OWN features kept together — the
 * grouped view of `includedFeatures()`. Handed to the narrative writer so it
 * can talk about the website and the social retainer as two separate things
 * instead of one undifferentiated bullet soup. Empty for a legacy selection,
 * whose single package is already described by `includedFeatures()`.
 */
export function proposalPackages(
  sel: ProposalSelection,
): { label: string; features: string[]; recurrence: LineRecurrence }[] {
  return validItems(sel).map((i) => ({
    label: i.label.trim(),
    features: featuresOf(i),
    recurrence: recurrenceOf(i),
  }));
}

/**
 * What follows the figure in the Investment table's AMOUNT cell. Derived from
 * `recurrence` and never from stored text, so a monthly line can only ever
 * print one way. `at_cost` returns null — that cell prints "At cost" instead
 * of a number, which is why it has no suffix to give.
 */
export function recurrenceSuffix(r: LineRecurrence | undefined): string | null {
  switch (r) {
    case "monthly":
      return "/month";
    case "yearly":
      return "/year";
    case "at_cost":
      return null;
    default:
      return "";
  }
}

/** "Rs 60,000" */
export function money(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  return `Rs ${v.toLocaleString("en-US")}`;
}

// ---- Editable content shape ---------------------------------------------

export type ObjectiveGroup = { group: string; items: string[] };
export type FeatureBlock = { heading: string; intro: string; bullets: string[] };
export type TimelineStep = { title: string; description: string; duration: string };

// ---- Free-form sections (additive; content without `sections` is untouched) ----

/**
 * The closed set of shapes the proposal PDF can render beautifully. The AGENT
 * is free in CONTENT and ORDER — it is not free in LAYOUT, because every shape
 * here maps onto styles that already exist in src/lib/proposal-pdf.tsx. That is
 * what keeps an arbitrary section looking like an ARC AI proposal.
 */
export type ProposalBody =
  /** Paragraphs, one per entry. Renders with the standard paragraph style. */
  | { kind: "prose"; paragraphs: string[] }
  /** Flat bullet list. Renders through the existing <Bullets/>. */
  | { kind: "bullets"; items: string[] }
  /** Bold sub-heading + optional intro + bullets, repeated. Exactly the shape
   * Objectives and Key Features already use. */
  | {
      kind: "groups";
      groups: { heading: string; intro?: string; items: string[] }[];
    }
  /** Numbered steps in the black chip. Same rows as the timeline, without the
   * duration line. */
  | { kind: "steps"; steps: { title: string; description?: string }[] }
  /** Two-column feature grid: bold title over one muted line, 50% cells,
   * flexWrap. The right shape for "what's included" across two packages. */
  | {
      kind: "features";
      items: { title: string; description?: string }[];
    }
  /** The dated timeline — reuses TimelineStep so an agent-written schedule
   * renders identically to content.timeline. */
  | { kind: "timeline"; steps: TimelineStep[] }
  /** Two-column labelled table, drawn with the Investment grid's own styles. */
  | {
      kind: "table";
      columns: [string, string];
      rows: [string, string][];
      /** Left column width, default "32%". The right column takes the rest. */
      labelWidth?: string;
    }
  /** Small muted footnote. */
  | { kind: "note"; text: string };

/** One numbered section of the proposal, written by the agent. */
export type ProposalSection = {
  /** Stable within one proposal; how update_proposal edits or drops a section. */
  id: string;
  /** Printed uppercase next to its number, exactly like every fixed section. */
  heading: string;
  /** Where it sits relative to the Investment table. Default "before". */
  placement?: "before" | "after";
  /** One or more bodies, rendered in order — intro prose then bullets, etc. */
  body: ProposalBody[];
};

/** What free-form sections do to the fixed skeleton. See `ProposalContent`. */
export type ProposalSectionsMode = "replace_narrative" | "append" | "replace_all";

export type ProposalContent = {
  overview: string;
  objectives: ObjectiveGroup[];
  keyFeatures: FeatureBlock[];
  educational: {
    intro: string;
    bullets: string[];
    aiAgent: { intro: string; capabilities: string[]; note: string } | null;
  };
  seo: { bullets: string[]; whyDedicated: string };
  timeline: TimelineStep[];
  paymentTerms: string[];
  hosting: { hosting: string; storage: string; domain: string };
  maintenance: string[];
  quality: { bullets: string[]; assumptions: string[]; nextSteps: string[] };
  /**
   * The agent's own sections, in its own order. ABSENT or EMPTY = the fixed
   * skeleton above renders exactly as it always has. Never backfilled.
   */
  sections?: ProposalSection[];
  /**
   * What `sections` does to the fixed skeleton. Only consulted when `sections`
   * is non-empty; absent behaves as "replace_narrative".
   *   replace_narrative — the six narrative sections (Overview, Objectives,
   *     Key Features, Educational Strategy, SEO, Timeline) are SUPPRESSED and
   *     the agent's sections take their place. Investment, Terms of Payment,
   *     Maintenance & Support, Quality Standards and the sign-off still print.
   *     This is the default because an SEO heading on a proposal with no SEO in
   *     it is the exact complaint being fixed.
   *   append — the fixed narrative prints first, then the agent's sections.
   *     For adding one section to an existing proposal without rewriting it.
   *   replace_all — only Investment and the sign-off survive; the agent must
   *     then write its own terms. Never the default; never chosen implicitly.
   */
  sectionsMode?: ProposalSectionsMode;
};

/**
 * A full, sensible default proposal body. AI generation overrides the
 * narrative fields; the static legal/terms blocks below stay as-is but
 * remain fully editable in the form.
 */
export function defaultContent(): ProposalContent {
  return {
    overview: "",
    objectives: [],
    keyFeatures: [],
    educational: { intro: "", bullets: [], aiAgent: null },
    seo: { bullets: [], whyDedicated: "" },
    timeline: [
      { title: "Strategy & Kickoff", description: "Confirm pages, structure, and design direction", duration: "Day 1-2" },
      { title: "Design & Content", description: "UI polish in your brand style; persuasive copy; review & sign-off", duration: "Day 3-5" },
      { title: "Build & Integrations", description: "Supabase setup, database, and CRM interface", duration: "Day 5-8" },
      { title: "QA, Launch, Optimize", description: "Accessibility, responsive checks, bug-fixing, performance tuning, go-live", duration: "Day 8-10" },
    ],
    paymentTerms: [
      "70% upfront payment required before project commencement.",
      "30% final payment due upon project completion and before launch, handover, admin access, credentials, or transfer of final files.",
      "Work will begin only after the upfront payment is received.",
      "The website will not be launched, published, transferred, or handed over until the final payment has been received in full.",
    ],
    hosting: {
      hosting: "Hosting is included under the agreed setup, subject to normal usage limits.",
      storage:
        "Supabase includes 500MB free backend storage. If the project exceeds the free storage limits, any required upgrade or additional backend cost will be discussed and approved before billing.",
      domain:
        "Domain purchase and renewal are not included. The domain must be provided or purchased by the client.",
    },
    maintenance: [
      "Website Protection plans — 3 months Rs 40,000 · 6 months Rs 60,000 · 12 months Rs 90,000.",
      "Includes security & dependency updates, uptime monitoring & backups, minor text/image updates, and priority bug fixes.",
      "Pay-Per-Fix — Rs 5,000 per fix for small bugs, UI tweaks, text/image updates, or broken links.",
      "New pages and custom feature development are quoted separately based on scope.",
    ],
    quality: {
      bullets: [
        "Performance: optimised images, clean code, and light frameworks for fast loading.",
        "SEO: clear page structure, proper titles, and meta data for key pages.",
        "Usability: mobile-first design with simple navigation and clear calls to action.",
      ],
      assumptions: [
        "Client will provide logo, brand colors, and fonts where available.",
        "Client will provide product data and images in a usable format.",
        "Client will provide or approve policy text.",
      ],
      nextSteps: [
        "Approve this proposal & scope.",
        "Sign the service agreement.",
        "Share all content/assets; confirm hosting preference.",
        "Kickoff and build commence.",
      ],
    },
  };
}

// ---- Catalog -> line item bridge ----------------------------------------

/**
 * The /pricing catalog and the proposal catalog above only ever met in ONE
 * direction: `proposal-pricing.ts` resolved a selection into up to three bare
 * numbers. Nothing could go the other way, so two thirds of the price list —
 * every social retainer, every AI automation tier, every /post and /reel
 * add-on — was unreachable from a proposal, and a package's real features
 * could never be carried across.
 *
 * These three functions invert it: name a price key, get a fully-formed line
 * item with the package's own features copied in. That is "get the pricing,
 * then put those features in the proposal" as a single call, and it cannot
 * drift from the /pricing page because it reads the same catalog.
 */

/** Locate one price field in the live catalog, with its package for context. */
export function findCatalogPrice(
  groups: PricingGroup[],
  key: string,
): { group: PricingGroup; pkg: PricingPackage; field: PriceField } | null {
  for (const group of groups) {
    for (const pkg of group.packages) {
      for (const field of pkg.prices) {
        if (field.key === key) return { group, pkg, field };
      }
    }
  }
  return null;
}

/**
 * Recurrence inferred from PriceField.suffix — the catalog already encodes it.
 * "/month" -> monthly; "/year" -> yearly; everything else ("one-time", "each",
 * "/post", "/reel", "/shoot", "/session", "/request", "/page", undefined) ->
 * one_time. "at_cost" is never inferred: only a human or the tool layer,
 * saying so explicitly, can mark a line as charged through at cost.
 */
export function recurrenceForField(f: PriceField): LineRecurrence {
  const suffix = (f.suffix ?? "").trim().toLowerCase();
  if (suffix === "/month") return "monthly";
  if (suffix === "/year") return "yearly";
  return "one_time";
}

/** A stable, readable id for a bespoke line the team wrote by hand. */
export function lineItemId(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "item";
}

/**
 * A package's default printed name. Catalog packages inside a group are often
 * named by tier alone ("Intermediate", "Flow"), which is meaningless on its own
 * in an Investment table — so a single-word name is qualified by its group.
 * A package carrying more than one price gets the price's own label too, so
 * "Smart Store System — Total" and "— AI layer" stay distinguishable.
 */
function catalogLabel(group: PricingGroup, pkg: PricingPackage, field: PriceField): string {
  const base = pkg.name.trim().includes(" ") ? pkg.name.trim() : `${group.title} — ${pkg.name.trim()}`;
  return pkg.prices.length > 1 ? `${base} — ${field.label}` : base;
}

/**
 * Build a ProposalLineItem from a catalog key, COPYING the package's features
 * in so the proposal prints what the client is buying — the whole point.
 *
 * `over` lets the team's dictated figures win: `amount` is used EXACTLY as
 * given and is never rounded or reconciled against the catalog. Passing an
 * amount below the catalog price records that price as `listAmount`, so the
 * proposal prints "~~Rs 250,000~~ Rs 200,000" without anyone typing it twice,
 * and clears "(starts at)" because an exact figure has now been agreed.
 *
 * Returns null for an unknown key or a USD-priced field — the proposal PDF
 * totals in LKR only, and silently mixing currencies into one column would
 * misstate the total.
 */
export function lineItemFromCatalog(
  groups: PricingGroup[],
  key: string,
  over?: {
    label?: string;
    amount?: number;
    listAmount?: number;
    quantity?: number;
    features?: string[];
    note?: string;
    recurrence?: LineRecurrence;
  },
): ProposalLineItem | null {
  const found = findCatalogPrice(groups, key);
  if (!found) return null;
  const { group, pkg, field } = found;
  if ((field.currency ?? "LKR") !== "LKR") return null;

  const dictated = typeof over?.amount === "number" && Number.isFinite(over.amount);
  const amount = dictated ? (over as { amount: number }).amount : field.amount;
  const listAmount =
    typeof over?.listAmount === "number" && Number.isFinite(over.listAmount)
      ? over.listAmount
      : dictated && field.amount > amount
        ? field.amount
        : undefined;

  const item: ProposalLineItem = {
    id: key,
    catalogKey: key,
    packageKey: pkg.key,
    label: over?.label?.trim() || catalogLabel(group, pkg, field),
    // Copy, never alias: this array otherwise IS the module-level catalog's
    // own, and one in-place edit downstream would silently rewrite the price
    // list for the whole process.
    features: [...(over?.features ?? pkg.features ?? [])],
    amount,
    recurrence: over?.recurrence ?? recurrenceForField(field),
    // "from Rs 450,000" is a floor. Once a figure has been agreed it is no
    // longer a floor, so the suffix comes off — the same rule buildPricing
    // has always applied to the legacy base line.
    startsAt: field.prefix === "from" && !dictated,
  };
  if (listAmount !== undefined) item.listAmount = listAmount;
  if (typeof over?.quantity === "number" && Number.isFinite(over.quantity) && over.quantity > 0) {
    item.quantity = over.quantity;
  }
  if (over?.note?.trim()) item.note = over.note.trim();
  return item;
}
