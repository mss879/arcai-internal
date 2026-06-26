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

export type ProjectType = "business" | "ecommerce";
export type BusinessTierKey = "starter" | "launch" | "growth" | "scale";
export type EcommercePlatform = "shopify" | "custom";
export type MaintenanceKey = "none" | "m3" | "m6" | "m12";

export type ProposalSelection = {
  type: ProjectType;
  tier: BusinessTierKey; // used when type === "business"
  platform: EcommercePlatform; // used when type === "ecommerce"
  paymentGateway: boolean; // custom e-commerce add-on
  delivery: boolean; // custom e-commerce add-on
  maintenance: MaintenanceKey;
  monthlySeo: boolean;
  customFeatures: { name: string; price: number }[];
};

export function defaultSelection(): ProposalSelection {
  return {
    type: "business",
    tier: "growth",
    platform: "custom",
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
  pages: number;
  additionalPageRate: number;
  hasCRM: boolean;
  hasAI: boolean;
  monthlyNote?: string;
  features: string[];
};

export const BUSINESS_TIERS: Record<BusinessTierKey, BusinessTier> = {
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

export const ECOMMERCE: {
  shopify: EcommercePlan;
  custom: EcommercePlan;
  addons: { paymentGateway: number; delivery: number };
} = {
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
  addons: { paymentGateway: 25000, delivery: 25000 },
};

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
      label: `${t.name} Website — ${t.pages} pages`,
      amount: t.price,
    });
    if (t.monthlyNote) recurringNotes.push(t.monthlyNote);
  } else if (sel.platform === "shopify") {
    lineItems.push({ label: ECOMMERCE.shopify.name, amount: ECOMMERCE.shopify.price });
    recurringNotes.push(ECOMMERCE.shopify.monthlyNote);
  } else {
    lineItems.push({
      label: `${ECOMMERCE.custom.name} (starts at)`,
      amount: ECOMMERCE.custom.price,
    });
    recurringNotes.push(ECOMMERCE.custom.monthlyNote);
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
  if (sel.platform === "shopify") return "E-Commerce — Shopify Store";
  const extras = [
    sel.paymentGateway && "Payment Gateway",
    sel.delivery && "Delivery",
  ]
    .filter(Boolean)
    .join(" + ");
  return `E-Commerce — Custom Next.js Store${extras ? ` + ${extras}` : ""}`;
}

/** Short project name suggestion for the cover (e.g. "Website + AI Agent"). */
export function suggestedProjectName(sel: ProposalSelection): string {
  if (sel.type === "ecommerce") return "E-Commerce Store";
  const t = BUSINESS_TIERS[sel.tier];
  if (t.hasAI) return "Website + AI Agent";
  if (t.hasCRM) return "Website + Backend CRM";
  return "Business Website";
}

/** Feature bullets of the selected package — handed to the AI as grounding. */
export function includedFeatures(sel: ProposalSelection): string[] {
  if (sel.type === "business") return BUSINESS_TIERS[sel.tier].features;
  return sel.platform === "shopify"
    ? ECOMMERCE.shopify.features
    : ECOMMERCE.custom.features;
}

/** "Rs 60,000" */
export function money(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  return `Rs ${v.toLocaleString("en-US")}`;
}

// ---- Editable content shape ---------------------------------------------

export type ObjectiveGroup = { group: string; items: string[] };
export type StructurePage = { page: string; description: string };
export type FeatureBlock = { heading: string; intro: string; bullets: string[] };
export type TimelineStep = { title: string; description: string; duration: string };

export type ProposalContent = {
  overview: string;
  objectives: ObjectiveGroup[];
  websiteStructure: StructurePage[];
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
    websiteStructure: [],
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
