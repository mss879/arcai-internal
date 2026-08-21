/**
 * Proposal catalog + pricing.
 *
 * This is the SINGLE SOURCE OF TRUTH for everything a proposal can cost.
 * The generator form, the live preview and the server-side PDF all import
 * `buildPricing()` from here so the numbers are identical everywhere — and
 * the AI text generator is never allowed to invent a price.
 *
 * Figures come from the ARC AI pricing catalog (LKR, one-time unless noted).
 */

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

export type PriceLine = { label: string; amount: number };
export type Pricing = {
  lineItems: PriceLine[];
  oneTimeTotal: number;
  recurringNotes: string[];
};

/** Deterministically turn a selection into priced line items + recurring notes. */
export function buildPricing(sel: ProposalSelection): Pricing {
  const lineItems: PriceLine[] = [];
  const recurringNotes: string[] = [];

  if (sel.type === "business") {
    const t = BUSINESS_TIERS[sel.tier];
    lineItems.push({
      label: `${t.name} Website — ${t.pages} pages${t.startsAt ? " (starts at)" : ""}`,
      amount: t.price,
    });
    if (t.monthlyNote) recurringNotes.push(t.monthlyNote);
  } else if (sel.type === "agent") {
    const plan = AGENT_PLANS[sel.agentPlatform ?? "whatsapp"];
    lineItems.push({ label: `${plan.name} — setup`, amount: plan.price });
    recurringNotes.push(plan.monthlyNote);
  } else {
    // A selection saved before the 2026-08 repricing can carry a legacy
    // platform — it must keep pricing exactly as it did the day it was sent.
    const plan = ECOMMERCE[sel.platform] ?? ECOMMERCE.store;
    lineItems.push({
      label: plan.startsAt ? `${plan.name} (starts at)` : plan.name,
      amount: plan.price,
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
    lineItems.push({ label: m.name, amount: m.price });
  }

  if (sel.monthlySeo) {
    recurringNotes.push(`Monthly SEO — ${money(MONTHLY_SEO)}/month`);
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

  const oneTimeTotal = lineItems.reduce((s, l) => s + l.amount, 0);
  return { lineItems, oneTimeTotal, recurringNotes };
}

/** Short human label for the selected package, e.g. for the cover + AI prompt. */
export function selectionSummary(sel: ProposalSelection): string {
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
  if (sel.type === "business") return BUSINESS_TIERS[sel.tier].features;
  if (sel.type === "agent")
    return AGENT_PLANS[sel.agentPlatform ?? "whatsapp"].features;
  return (ECOMMERCE[sel.platform] ?? ECOMMERCE.store).features;
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
